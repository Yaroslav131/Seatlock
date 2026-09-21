import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { Order, Prisma } from '../generated/prisma';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort, PAYMENT_PROVIDER } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async handle(rawBody: Buffer, signature: string | undefined): Promise<void> {
    const event = this.provider.verifyWebhookSignature(rawBody, signature);
    if (!event) {
      throw new BadRequestException('Недействительная подпись вебхука');
    }

    const order = await this.prisma.order.findUnique({
      where: { providerIntentId: event.providerIntentId },
    });
    if (!order) {
      // Не 500 — провайдер вполне может прислать событие про intent,
      // о котором мы уже ничего не знаем (например, тестовые события
      // на чужой аккаунт). Обрабатывать нечего.
      this.logger.warn(`вебхук на неизвестный providerIntentId=${event.providerIntentId}`);
      return;
    }

    if (event.type === 'payment.succeeded') {
      await this.markPaid(order);
    } else {
      await this.markCancelled(order);
    }
  }

  /** Только для PAYMENT_PROVIDER=fake — см. providers/fake-payment.provider.ts. */
  async handleFakeWebhook(rawBody: Buffer): Promise<void> {
    if (this.config.get<string>('PAYMENT_PROVIDER', 'fake') !== 'fake') {
      throw new NotFoundException();
    }
    await this.handle(rawBody, undefined);
  }

  private async markPaid(order: Order): Promise<void> {
    if (order.status !== 'PENDING') {
      // Идемпотентность: повторная доставка уже обработанного события
      // (вебхуки штатно могут прийти дважды) — no-op, не отдельная
      // таблица "обработанных event id". Состояние заказа само себя
      // защищает от повторной обработки.
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
      await this.outbox.record(tx, 'order.paid', {
        orderId: order.id,
        userId: order.userId,
        eventId: order.eventId,
        seatId: order.seatId,
        // Нужно notification для PDF-билета/письма — эти данные уже
        // есть в памяти на этот момент, лишнего похода за ними не надо.
        amountCents: order.amountCents,
        // Снимок билета из заказа (email, событие, зал, место): notification
        // выдаёт билет без единого сетевого вызова. Нет снимка — поле опускается,
        // и notification берёт данные по-старому (docs/adr/0005).
        ...(order.ticketSnapshot ? { ticket: order.ticketSnapshot as Prisma.InputJsonObject } : {}),
      });
    });

    await this.releaseBookingHold(order.eventId, order.userId);
  }

  private async markCancelled(order: Order): Promise<void> {
    if (order.status !== 'PENDING') {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
      await this.outbox.record(tx, 'order.cancelled', {
        orderId: order.id,
        userId: order.userId,
        eventId: order.eventId,
        seatId: order.seatId,
      });
    });
  }

  /**
   * Best-effort: гасим Redis-холд покупателя в booking, он больше не
   * нужен — источник истины теперь БД (частичный уникальный индекс
   * orders_event_seat_active_key, см. schema.prisma). Неудача здесь
   * НЕ означает риск повторной продажи: даже если холд не погашен,
   * DB-констрейнт всё равно отклонит второй заказ на то же место, а
   * booking сам отпустит холд по TTL. Это чистка ради UX (место
   * перестаёт выглядеть занятым чужим холдом), а не гарантия.
   */
  private async releaseBookingHold(eventId: string, userId: string): Promise<void> {
    try {
      const bookingUrl = this.config.getOrThrow<string>('BOOKING_SERVICE_URL');
      await fetch(`${bookingUrl}/api/booking/events/${eventId}/holds`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.mintInternalToken(userId)}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `не удалось погасить Redis-холд после оплаты (eventId=${eventId}, userId=${userId}): ${message}`,
      );
    }
  }

  /**
   * Не для клиентов — только чтобы этот internal-вызов дошёл до
   * booking от имени покупателя (booking проверяет холд по user.sub
   * из токена). Тот же секрет, что у всех сервисов, поэтому booking
   * не отличит его от настоящего access-токена; живёт минуту, нигде,
   * кроме этого одного вызова, не используется и никогда не попадает
   * ни в один ответ payment наружу.
   */
  private mintInternalToken(userId: string): string {
    return jwt.sign(
      { sub: userId, email: `internal-${userId}@seatlock.internal`, role: 'USER' },
      this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      { expiresIn: '1m' },
    );
  }
}
