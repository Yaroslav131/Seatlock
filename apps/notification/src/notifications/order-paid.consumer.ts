import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { MailService } from '../mail/mail.service';
import { orderPaidProcessedTotal } from '../metrics/business-metrics';
import { PrismaService } from '../prisma/prisma.service';
import { ORDER_PAID_QUEUE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { TicketData, TicketPdfService } from '../tickets/ticket-pdf.service';
import { TicketStorageService } from '../tickets/ticket-storage.service';

interface OrderPaidEvent {
  orderId: string;
  userId: string;
  eventId: string;
  seatId: string;
  amountCents: number;
}

interface CatalogEvent {
  title: string;
  startsAt: string;
  venueId: string;
}

interface CatalogVenue {
  name: string;
  city: string;
  address: string;
}

interface CatalogSeat {
  id: string;
  section: string | null;
  row: number;
  number: number;
}

const NOTIFICATION_TYPE = 'TICKET_EMAIL';

/**
 * Первый consumer RabbitMQ в проекте (payment был только publisher'ом).
 * На каждое order.paid: письмо с PDF-билетом. Успех/неуспех — ack/nack
 * в конце handle(), без промежуточных ack — падение процесса
 * посередине просто вернёт недоставленное сообщение в очередь для
 * повторной обработки (или другого воркера), а не потеряет его.
 */
@Injectable()
export class OrderPaidConsumer implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrderPaidConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pdf: TicketPdfService,
    private readonly storage: TicketStorageService,
    private readonly mail: MailService,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: amqp.Channel,
  ) {}

  onApplicationBootstrap(): void {
    void this.channel.consume(ORDER_PAID_QUEUE, (msg) => {
      if (msg) void this.handle(msg);
    });
  }

  async handle(msg: amqp.ConsumeMessage): Promise<void> {
    let event: OrderPaidEvent;
    try {
      event = JSON.parse(msg.content.toString('utf-8')) as OrderPaidEvent;
    } catch (error) {
      // Битое сообщение — повторная попытка не поможет, сразу в DLQ,
      // а не бесконечный цикл nack→redeliver→nack.
      this.logger.error(`не удалось распарсить order.paid: ${String(error)}`);
      this.channel.nack(msg, false, false);
      return;
    }

    const existing = await this.prisma.notificationLog.findUnique({
      where: { orderId_type: { orderId: event.orderId, type: NOTIFICATION_TYPE } },
    });
    if (existing?.status === 'SENT') {
      // Повторная доставка (redelivery после разрыва соединения до
      // ack) уже обработанного заказа — не отправляем письмо дважды.
      // Тот же принцип, что order.status !== 'PENDING' в payment.
      this.channel.ack(msg);
      return;
    }

    try {
      const [{ email }, ticketData] = await Promise.all([
        this.fetchUserEmail(event.userId),
        this.buildTicketData(event),
      ]);

      const pdf = await this.pdf.generate(ticketData);
      const pdfKey = await this.storage.uploadTicket(event.orderId, pdf);
      await this.mail.sendTicket({ to: email, eventTitle: ticketData.eventTitle, pdf });

      await this.prisma.notificationLog.upsert({
        where: { orderId_type: { orderId: event.orderId, type: NOTIFICATION_TYPE } },
        create: { orderId: event.orderId, type: NOTIFICATION_TYPE, status: 'SENT', pdfKey },
        update: { status: 'SENT', pdfKey, errorMessage: null },
      });
      orderPaidProcessedTotal.inc({ result: 'sent' });
      this.channel.ack(msg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`не удалось обработать order.paid ${event.orderId}: ${message} — в DLQ`);
      await this.prisma.notificationLog.upsert({
        where: { orderId_type: { orderId: event.orderId, type: NOTIFICATION_TYPE } },
        create: {
          orderId: event.orderId,
          type: NOTIFICATION_TYPE,
          status: 'FAILED',
          errorMessage: message,
        },
        update: { status: 'FAILED', errorMessage: message },
      });
      orderPaidProcessedTotal.inc({ result: 'failed' });
      // requeue:false — без цикла ретраев в этой версии (см. план),
      // сообщение уходит в DLQ через x-dead-letter-exchange.
      this.channel.nack(msg, false, false);
    }
  }

  private async fetchUserEmail(userId: string): Promise<{ email: string }> {
    const authUrl = this.config.getOrThrow<string>('AUTH_SERVICE_URL');
    const res = await fetch(`${authUrl}/api/internal/users/${userId}`);
    if (!res.ok) {
      throw new Error(`auth вернул ${res.status} для userId=${userId}`);
    }
    return (await res.json()) as { email: string };
  }

  private async buildTicketData(event: OrderPaidEvent): Promise<TicketData> {
    const catalogUrl = this.config.getOrThrow<string>('CATALOG_SERVICE_URL');

    const eventRes = await fetch(`${catalogUrl}/api/catalog/events/${event.eventId}`);
    if (!eventRes.ok) {
      throw new Error(`catalog вернул ${eventRes.status} для eventId=${event.eventId}`);
    }
    const catalogEvent = (await eventRes.json()) as CatalogEvent;

    const [venueRes, seatsRes] = await Promise.all([
      fetch(`${catalogUrl}/api/catalog/venues/${catalogEvent.venueId}`),
      fetch(`${catalogUrl}/api/catalog/venues/${catalogEvent.venueId}/seats`),
    ]);
    if (!venueRes.ok || !seatsRes.ok) {
      throw new Error(`catalog недоступен для venueId=${catalogEvent.venueId}`);
    }
    const venue = (await venueRes.json()) as CatalogVenue;
    const seats = (await seatsRes.json()) as CatalogSeat[];
    // Отдельного эндпоинта "одно место по id" в catalog нет — заводить
    // его ради единственного асинхронного потребителя не нужно,
    // фильтруем на своей стороне.
    const seat = seats.find((s) => s.id === event.seatId);
    if (!seat) {
      throw new Error(`место ${event.seatId} не найдено в venue ${catalogEvent.venueId}`);
    }

    return {
      orderId: event.orderId,
      eventTitle: catalogEvent.title,
      startsAt: new Date(catalogEvent.startsAt),
      venueName: venue.name,
      venueCity: venue.city,
      venueAddress: venue.address,
      seatSection: seat.section,
      seatRow: seat.row,
      seatNumber: seat.number,
      amountCents: event.amountCents,
    };
  }
}
