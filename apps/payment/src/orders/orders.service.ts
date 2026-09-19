import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { Order, Prisma } from '../generated/prisma';
import { ordersCreatedTotal } from '../metrics/business-metrics';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort, PAYMENT_PROVIDER } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';

interface MyHold {
  seatId: string;
  expiresAt: string;
}

interface CatalogEvent {
  status: string;
  basePriceCents: number;
  organizerId: string;
}

const CURRENCY = 'usd';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  /**
   * Создание заказа — переход из временного Redis-холда (booking,
   * ADR 0003) в персистентный заказ. Это первый в проекте случай
   * прямого server-to-server вызова между сервисами в обход gateway
   * (см. комментарий в holds.controller.ts: раньше такого не было,
   * потому что цена ошибки была нулевой — призрачный холд просто сам
   * истекал по TTL). Здесь цена ошибки — реальные деньги, поэтому
   * заказ создаётся только после того, как оба факта подтверждены
   * напрямую у источников истины (booking — что место реально
   * держит именно этот юзер; catalog — что событие правда
   * опубликовано и почём).
   */
  async create(
    dto: CreateOrderDto,
    user: AuthenticatedUser,
    authorizationHeader: string,
  ): Promise<{ order: Order; clientSecret: string }> {
    const hold = await this.fetchMyHold(dto.eventId, authorizationHeader);
    if (!hold || hold.seatId !== dto.seatId) {
      ordersCreatedTotal.inc({ result: 'forbidden' });
      throw new ForbiddenException('Вы не держите это место — сначала займите его на карте зала');
    }

    const event = await this.fetchEvent(dto.eventId);
    if (event.status !== 'PUBLISHED') {
      ordersCreatedTotal.inc({ result: 'forbidden' });
      throw new ForbiddenException('Событие ещё не опубликовано');
    }

    let order: Order;
    try {
      order = await this.prisma.order.create({
        data: {
          eventId: dto.eventId,
          seatId: dto.seatId,
          userId: user.sub,
          amountCents: event.basePriceCents,
        },
      });
    } catch (error) {
      // P2002 здесь ловит и обычный @unique (providerIntentId), и наш
      // частичный индекс orders_event_seat_active_key — оба заведены
      // как настоящие constraint'ы Postgres, Prisma мапит любое
      // нарушение уникальности в один и тот же код независимо от
      // того, объявлен индекс в schema.prisma или дописан вручную в
      // migration.sql (см. комментарий там же).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        ordersCreatedTotal.inc({ result: 'conflict' });
        throw new ConflictException('Это место уже покупается — попробуйте другое');
      }
      throw error;
    }

    // Намеренно вне транзакции с созданием заказа: держать
    // БД-транзакцию открытой на время сетевого похода к платёжному
    // провайдеру — антипаттерн (риск долгих локов). Если этот вызов
    // упадёт, заказ остаётся PENDING без providerIntentId — известный
    // компромисс этой фазы, не заметается уборкой "на всякий случай".
    const { providerIntentId, clientSecret } = await this.provider.createPaymentIntent({
      amountCents: order.amountCents,
      currency: CURRENCY,
      metadata: { orderId: order.id },
    });

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: { providerIntentId },
    });

    ordersCreatedTotal.inc({ result: 'ok' });
    return { order: updated, clientSecret };
  }

  /**
   * ORGANIZER видит заказы только своего события (сверяем organizerId из
   * catalog — payment сам его не хранит), ADMIN — любого. Та же живая
   * проверка через catalog, что уже делает create() при создании заказа.
   */
  async listByEvent(eventId: string, user: AuthenticatedUser): Promise<Order[]> {
    const event = await this.fetchEvent(eventId);
    if (user.role !== 'ADMIN' && event.organizerId !== user.sub) {
      throw new ForbiddenException('Это не ваше событие');
    }
    return this.prisma.order.findMany({ where: { eventId }, orderBy: { createdAt: 'desc' } });
  }

  /** Публично, для карты зала — тот же принцип, что и HoldsController.listHeld в booking. */
  async listSoldSeatIds(eventId: string): Promise<string[]> {
    const orders = await this.prisma.order.findMany({
      where: { eventId, status: 'PAID' },
      select: { seatId: true },
    });
    return orders.map((order) => order.seatId);
  }

  async refund(orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException('Заказ не найден');
    }
    if (order.status !== 'PAID') {
      throw new ForbiddenException('Вернуть можно только оплаченный заказ');
    }
    if (!order.providerIntentId) {
      // Защита от невозможного состояния (PAID без providerIntentId
      // не должно случиться — webhook переводит в PAID только заказы
      // с уже сохранённым intent'ом), а не ожидаемая ветка.
      throw new ConflictException('У заказа нет платёжного намерения — обратитесь в поддержку');
    }

    const { providerRefundId } = await this.provider.refund(
      order.providerIntentId,
      order.amountCents,
    );

    return this.prisma.$transaction(async (tx) => {
      const refunded = await tx.order.update({
        where: { id: order.id },
        data: { status: 'REFUNDED', providerRefundId },
      });
      await this.outbox.record(tx, 'order.refunded', {
        orderId: refunded.id,
        userId: refunded.userId,
        eventId: refunded.eventId,
        seatId: refunded.seatId,
      });
      return refunded;
    });
  }

  private async fetchMyHold(eventId: string, authorization: string): Promise<MyHold | null> {
    const bookingUrl = this.config.getOrThrow<string>('BOOKING_SERVICE_URL');
    const res = await fetch(`${bookingUrl}/api/booking/events/${eventId}/my-hold`, {
      headers: { Authorization: authorization },
    });
    if (res.status === 401) {
      throw new ForbiddenException('Недействительный access-токен');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException('booking недоступен');
    }
    // NestJS отдаёт 200 с ПУСТЫМ телом (не 204), когда контроллер
    // возвращает null — тот самый баг, что чинили на фронте в
    // apps/web/src/lib/api-client.ts. Читаем как текст и парсим
    // только непустой ответ, а не res.json() напрямую.
    const text = await res.text();
    return text ? (JSON.parse(text) as MyHold) : null;
  }

  private async fetchEvent(eventId: string): Promise<CatalogEvent> {
    const catalogUrl = this.config.getOrThrow<string>('CATALOG_SERVICE_URL');
    const res = await fetch(`${catalogUrl}/api/catalog/events/${eventId}`);
    if (res.status === 404) {
      throw new NotFoundException('Событие не найдено');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException('catalog недоступен');
    }
    return (await res.json()) as CatalogEvent;
  }
}
