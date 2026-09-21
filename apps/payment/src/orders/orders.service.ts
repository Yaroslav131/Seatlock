import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { Order, Prisma } from '../generated/prisma';
import { ordersCreatedTotal } from '../metrics/business-metrics';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort, PAYMENT_PROVIDER } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CatalogTicketInfo, parseCatalogTicketInfo, TicketSnapshot } from './ticket-snapshot';

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
  private readonly logger = new Logger(OrdersService.name);

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
    // Идемпотентность: заказ на это место уже есть. Свой — повтор (клиент не
    // дождался ответа, дважды нажал кнопку) возвращает тот же заказ, а не 409.
    // Чужой — конфликт сразу, без походов в booking/catalog: на распроданном
    // событии это заметно дешевле прежнего пути.
    const existing = await this.findActiveOrder(dto.eventId, dto.seatId);
    if (existing) {
      return this.replayOrConflict(existing, user);
    }

    const hold = await this.fetchMyHold(dto.eventId, authorizationHeader);
    if (!hold || hold.seatId !== dto.seatId) {
      ordersCreatedTotal.inc({ result: 'forbidden' });
      throw new ForbiddenException('Вы не держите это место — сначала займите его на карте зала');
    }

    // Данные билета берём тем же походом в каталог, параллельно с проверкой
    // события: задержка заказа не растёт. Это необязательный снимок, а не условие
    // заказа: если каталог не ответил, заказ создаётся без него.
    const [event, ticketInfo] = await Promise.all([
      this.fetchEvent(dto.eventId),
      this.fetchTicketInfo(dto.eventId, dto.seatId),
    ]);
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
          ticketSnapshot: ticketInfo
            ? ({ buyerEmail: user.email, ...ticketInfo } satisfies TicketSnapshot)
            : undefined,
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
        // Гонка: между проверкой выше и вставкой заказ создал другой запрос —
        // в том числе двойной клик этого же пользователя. Смотрим, чей он.
        const raced = await this.findActiveOrder(dto.eventId, dto.seatId);
        if (raced) {
          return this.replayOrConflict(raced, user);
        }
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
    const result = await this.attachPaymentIntent(order);

    ordersCreatedTotal.inc({ result: 'ok' });
    return result;
  }

  /**
   * Создаёт платёжный intent и привязывает его к заказу, но только если у заказа
   * ещё нет своего. Условная привязка (updateMany where providerIntentId IS NULL)
   * нужна из-за двойного клика: два запроса могут одновременно дойти до этого
   * места, и безусловный update оставил бы в базе intent одного, а клиенту
   * отдал бы intent другого (оплата по нему нашла бы "неизвестный intent").
   * Проигравший берёт intent победителя; свой неиспользованный intent остаётся
   * у провайдера сиротой (неоплаченные intent у настоящих провайдеров истекают).
   */
  private async attachPaymentIntent(order: Order): Promise<{ order: Order; clientSecret: string }> {
    const { providerIntentId, clientSecret } = await this.provider.createPaymentIntent({
      amountCents: order.amountCents,
      currency: CURRENCY,
      metadata: { orderId: order.id },
    });

    const { count } = await this.prisma.order.updateMany({
      where: { id: order.id, providerIntentId: null },
      data: { providerIntentId },
    });
    const current = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });

    if (count === 1) {
      return { order: current, clientSecret };
    }
    return {
      order: current,
      clientSecret: await this.provider.getClientSecret(current.providerIntentId as string),
    };
  }

  private findActiveOrder(eventId: string, seatId: string): Promise<Order | null> {
    // Те же статусы, что в частичном уникальном индексе orders_event_seat_active_key.
    return this.prisma.order.findFirst({
      where: { eventId, seatId, status: { in: ['PENDING', 'PAID'] } },
    });
  }

  private async replayOrConflict(
    existing: Order,
    user: AuthenticatedUser,
  ): Promise<{ order: Order; clientSecret: string }> {
    if (existing.userId !== user.sub) {
      ordersCreatedTotal.inc({ result: 'conflict' });
      throw new ConflictException('Это место уже покупается — попробуйте другое');
    }
    ordersCreatedTotal.inc({ result: 'existing' });

    // Заказ создан, а платёжный intent тогда не удался (см. компромисс в
    // create()) — повтор довершает начатое, а не оставляет заказ без intent.
    if (!existing.providerIntentId) {
      return this.attachPaymentIntent(existing);
    }
    return {
      order: existing,
      clientSecret: await this.provider.getClientSecret(existing.providerIntentId),
    };
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

  private async fetchTicketInfo(
    eventId: string,
    seatId: string,
  ): Promise<CatalogTicketInfo | null> {
    try {
      const catalogUrl = this.config.getOrThrow<string>('CATALOG_SERVICE_URL');
      const res = await fetch(
        `${catalogUrl}/api/catalog/events/${eventId}/seats/${seatId}/ticket-info`,
      );
      if (!res.ok) {
        this.logger.warn(
          `данные билета недоступны (каталог ответил ${res.status}): заказ без снимка`,
        );
        return null;
      }
      const info = parseCatalogTicketInfo(await res.json());
      if (!info) {
        this.logger.warn('каталог вернул данные билета в неожиданной форме: заказ без снимка');
      }
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`данные билета не получены (${message}): заказ без снимка`);
      return null;
    }
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
