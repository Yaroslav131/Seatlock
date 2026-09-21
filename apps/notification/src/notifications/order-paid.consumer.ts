import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { MailService } from '../mail/mail.service';
import { orderPaidProcessedTotal, ticketDataSourceTotal } from '../metrics/business-metrics';
import { PrismaService } from '../prisma/prisma.service';
import { ORDER_PAID_QUEUE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { TicketData, TicketPdfService } from '../tickets/ticket-pdf.service';
import { parseTicketSnapshot } from '../tickets/ticket-snapshot';
import { TicketStorageService } from '../tickets/ticket-storage.service';

interface OrderPaidEvent {
  orderId: string;
  userId: string;
  eventId: string;
  seatId: string;
  amountCents: number;
  /** Снимок билета от payment (docs/adr/0005); у событий старой версии отсутствует. */
  ticket?: unknown;
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

// Аренда захвата: если воркер упал посреди обработки, по истечении этого
// срока заказ можно захватить заново. Должна с запасом покрывать PDF, S3 и SMTP.
const CLAIM_LEASE_SECONDS = 120;
// Заказ сейчас обрабатывает другой воркер: подождать и вернуть сообщение в очередь.
const BUSY_RETRY_DELAY_MS = 2_000;

type ClaimResult = 'claimed' | 'already-sent' | 'busy';

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

    const claim = await this.claim(event.orderId);
    if (claim === 'already-sent') {
      // Повторная доставка (redelivery после разрыва соединения до ack, дубль
      // из outbox) уже обработанного заказа — письмо второй раз не отправляем.
      orderPaidProcessedTotal.inc({ result: 'duplicate' });
      this.channel.ack(msg);
      return;
    }
    if (claim === 'busy') {
      // Этот заказ прямо сейчас обрабатывает другой воркер (или он упал и
      // аренда ещё не истекла). Не отбрасываем сообщение: если тот воркер
      // не закончит, именно эта копия подхватит заказ после истечения аренды.
      await this.sleep(BUSY_RETRY_DELAY_MS);
      this.channel.nack(msg, false, true);
      return;
    }

    try {
      const { email, ticketData } = await this.resolveTicket(event);

      const pdf = await this.pdf.generate(ticketData);
      const pdfKey = await this.storage.uploadTicket(event.orderId, pdf);
      await this.mail.sendTicket({ to: email, eventTitle: ticketData.eventTitle, pdf });

      await this.prisma.notificationLog.update({
        where: { orderId_type: { orderId: event.orderId, type: NOTIFICATION_TYPE } },
        data: { status: 'SENT', pdfKey, errorMessage: null, claimedAt: null },
      });
      orderPaidProcessedTotal.inc({ result: 'sent' });
      this.channel.ack(msg);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`не удалось обработать order.paid ${event.orderId}: ${message} — в DLQ`);
      await this.prisma.notificationLog.update({
        where: { orderId_type: { orderId: event.orderId, type: NOTIFICATION_TYPE } },
        data: { status: 'FAILED', errorMessage: message, claimedAt: null },
      });
      orderPaidProcessedTotal.inc({ result: 'failed' });
      // requeue:false — без цикла ретраев в этой версии (см. план),
      // сообщение уходит в DLQ через x-dead-letter-exchange.
      this.channel.nack(msg, false, false);
    }
  }

  /**
   * Атомарный захват заказа одним SQL-запросом (INSERT ... ON CONFLICT DO UPDATE
   * ... WHERE): проверка "уже отправлено" и постановка отметки "обрабатываю"
   * не разнесены во времени, поэтому два воркера (или дубль сообщения) не могут
   * оба решить, что заказ свободен, и отправить два письма.
   *
   * Захватить можно новую запись, FAILED (повтор из DLQ) и PROCESSING с
   * истёкшей арендой (воркер упал). SENT и свежий PROCESSING не захватываются.
   */
  private async claim(orderId: string): Promise<ClaimResult> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO notification_logs (id, "orderId", type, status, "claimedAt", "createdAt")
      VALUES (gen_random_uuid()::text, ${orderId}, ${NOTIFICATION_TYPE}, 'PROCESSING', now(), now())
      ON CONFLICT ("orderId", type) DO UPDATE
        SET status = 'PROCESSING', "claimedAt" = now(), "errorMessage" = NULL
        WHERE notification_logs.status = 'FAILED'
           OR (notification_logs.status = 'PROCESSING'
               AND notification_logs."claimedAt" < now() - (${CLAIM_LEASE_SECONDS}::int * interval '1 second'))
      RETURNING id
    `;
    if (rows.length > 0) {
      return 'claimed';
    }

    const existing = await this.prisma.notificationLog.findUnique({
      where: { orderId_type: { orderId, type: NOTIFICATION_TYPE } },
    });
    return existing?.status === 'SENT' ? 'already-sent' : 'busy';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Данные билета и адрес покупателя. Основной путь: снимок из самого события,
   * ни одного сетевого вызова. Запасной: событие от старой версии payment (в
   * очереди или outbox при деплое) не несёт снимка, и данные берутся по-старому
   * из catalog и auth.
   */
  private async resolveTicket(
    event: OrderPaidEvent,
  ): Promise<{ email: string; ticketData: TicketData }> {
    const snapshot = parseTicketSnapshot(event.ticket);
    if (snapshot) {
      ticketDataSourceTotal.inc({ source: 'snapshot' });
      return {
        email: snapshot.buyerEmail,
        ticketData: {
          orderId: event.orderId,
          eventTitle: snapshot.eventTitle,
          startsAt: new Date(snapshot.startsAt),
          venueName: snapshot.venueName,
          venueCity: snapshot.venueCity,
          venueAddress: snapshot.venueAddress,
          seatSection: snapshot.seatSection,
          seatRow: snapshot.seatRow,
          seatNumber: snapshot.seatNumber,
          amountCents: event.amountCents,
        },
      };
    }

    ticketDataSourceTotal.inc({ source: 'legacy' });
    const [{ email }, ticketData] = await Promise.all([
      this.fetchUserEmail(event.userId),
      this.buildTicketData(event),
    ]);
    return { email, ticketData };
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
