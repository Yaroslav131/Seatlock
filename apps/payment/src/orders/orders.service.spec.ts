import { ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { Prisma } from '../generated/prisma';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';

function createPrismaMock() {
  return {
    order: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
  };
}

function createConfigMock(values: Record<string, string>) {
  return { getOrThrow: jest.fn((key: string) => values[key]) };
}

function createProviderMock(): jest.Mocked<PaymentProviderPort> {
  return {
    createPaymentIntent: jest.fn(),
    getClientSecret: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    refund: jest.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

const user: AuthenticatedUser = { sub: 'user-1', email: 'u@seatlock.fun', role: 'USER' };
const eventId = 'event-1';
const seatId = 'seat-1';
const authorization = 'Bearer test-token';

describe('OrdersService', () => {
  let prisma: PrismaMock;
  let config: ReturnType<typeof createConfigMock>;
  let outbox: jest.Mocked<Pick<OutboxService, 'record'>>;
  let provider: jest.Mocked<PaymentProviderPort>;
  let service: OrdersService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.order.findFirst.mockResolvedValue(null); // по умолчанию активного заказа на место нет
    config = createConfigMock({
      BOOKING_SERVICE_URL: 'http://booking.local',
      CATALOG_SERVICE_URL: 'http://catalog.local',
    });
    outbox = { record: jest.fn() };
    provider = createProviderMock();
    service = new OrdersService(
      prisma as unknown as PrismaService,
      config as never,
      outbox as unknown as OutboxService,
      provider,
    );

    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // Отсутствие снимка билета в тестах, где он не нужен, пишет предупреждение — не засоряем вывод.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const catalogTicketInfo = {
    eventTitle: 'Концерт',
    startsAt: '2026-12-20T19:00:00.000Z',
    venueName: 'Дворец спорта',
    venueCity: 'Минск',
    venueAddress: 'пр. Победителей, 1',
    seatSection: 'A',
    seatRow: 3,
    seatNumber: 12,
  };

  function mockTicketInfoResponse(body: unknown, status = 200): void {
    fetchMock.mockResolvedValueOnce({
      status,
      ok: status < 400,
      json: () => Promise.resolve(body),
    });
  }

  function mockHoldResponse(body: unknown, status = 200): void {
    fetchMock.mockResolvedValueOnce({
      status,
      ok: status < 400,
      text: () => Promise.resolve(body === null ? '' : JSON.stringify(body)),
    });
  }

  function mockEventResponse(body: unknown, status = 200): void {
    fetchMock.mockResolvedValueOnce({
      status,
      ok: status < 400,
      json: () => Promise.resolve(body),
    });
  }

  describe('create', () => {
    it('счастливый путь: создаёт заказ PENDING и intent у провайдера', async () => {
      mockHoldResponse({ seatId, expiresAt: '2026-01-01T00:05:00.000Z' });
      mockEventResponse({ status: 'PUBLISHED', basePriceCents: 150000 });
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        eventId,
        seatId,
        userId: user.sub,
        amountCents: 150000,
        status: 'PENDING',
        providerIntentId: null,
      });
      provider.createPaymentIntent.mockResolvedValue({
        providerIntentId: 'fake_pi_1',
        clientSecret: 'fake_secret_1',
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'order-1',
        eventId,
        seatId,
        userId: user.sub,
        amountCents: 150000,
        status: 'PENDING',
        providerIntentId: 'fake_pi_1',
      });

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order.providerIntentId).toBe('fake_pi_1');
      expect(result.clientSecret).toBe('fake_secret_1');
      expect(provider.createPaymentIntent).toHaveBeenCalledWith({
        amountCents: 150000,
        currency: 'usd',
        metadata: { orderId: 'order-1' },
      });
    });

    it('нет своего холда на это место — 403, заказ не создаётся', async () => {
      mockHoldResponse(null); // getMyHold вернул null — пустое тело 200

      await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('холд есть, но на другое место — 403', async () => {
      mockHoldResponse({ seatId: 'other-seat', expiresAt: '2026-01-01T00:05:00.000Z' });

      await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('событие не PUBLISHED — 403, заказ не создаётся', async () => {
      mockHoldResponse({ seatId, expiresAt: '2026-01-01T00:05:00.000Z' });
      mockEventResponse({ status: 'DRAFT', basePriceCents: 150000 });

      await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('нарушение уникальности (место уже покупается) — 409, к провайдеру не ходим', async () => {
      mockHoldResponse({ seatId, expiresAt: '2026-01-01T00:05:00.000Z' });
      mockEventResponse({ status: 'PUBLISHED', basePriceCents: 150000 });
      prisma.order.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('нарушение уникальности', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
        ConflictException,
      );
      expect(provider.createPaymentIntent).not.toHaveBeenCalled();
    });
  });

  describe('create: снимок данных билета', () => {
    function arrangeHappyPath(): void {
      mockHoldResponse({ seatId, expiresAt: '2026-01-01T00:05:00.000Z' });
      mockEventResponse({ status: 'PUBLISHED', basePriceCents: 150000 });
      prisma.order.create.mockResolvedValue({
        id: 'order-1',
        eventId,
        seatId,
        userId: user.sub,
        amountCents: 150000,
        status: 'PENDING',
        providerIntentId: null,
      });
      provider.createPaymentIntent.mockResolvedValue({
        providerIntentId: 'fake_pi_1',
        clientSecret: 'fake_secret_1',
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        id: 'order-1',
        providerIntentId: 'fake_pi_1',
      });
    }

    it('заказ сохраняет снимок: email покупателя из токена + событие, зал, место из каталога', async () => {
      arrangeHappyPath();
      mockTicketInfoResponse(catalogTicketInfo);

      await service.create({ eventId, seatId }, user, authorization);

      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ticketSnapshot: { buyerEmail: user.email, ...catalogTicketInfo },
        }),
      });
    });

    it.each([
      ['каталог ответил 404', () => mockTicketInfoResponse({ message: 'нет' }, 404)],
      [
        'каталог ответил в неожиданной форме',
        () => mockTicketInfoResponse({ eventTitle: 'Концерт' }),
      ],
      [
        'каталог недоступен (сетевая ошибка)',
        () => fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED')),
      ],
    ])('%s — заказ всё равно создаётся, без снимка', async (_name, arrange) => {
      arrangeHappyPath();
      arrange();

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order.providerIntentId).toBe('fake_pi_1');
      expect(prisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ticketSnapshot: undefined }),
      });
    });
  });

  describe('create: идемпотентность', () => {
    const activeOrder = {
      id: 'order-1',
      eventId,
      seatId,
      userId: user.sub,
      amountCents: 150000,
      status: 'PENDING',
      providerIntentId: 'fake_pi_1',
    };

    it('повтор того же пользователя на то же место — тот же заказ, без походов в booking/catalog и без нового заказа', async () => {
      prisma.order.findFirst.mockResolvedValue(activeOrder);
      provider.getClientSecret.mockResolvedValue('fake_secret_fake_pi_1');

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order).toBe(activeOrder);
      expect(result.clientSecret).toBe('fake_secret_fake_pi_1');
      expect(provider.getClientSecret).toHaveBeenCalledWith('fake_pi_1');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(provider.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('повтор после того, как заказ уже оплачен (холд погашен) — возвращает его, а не 403', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...activeOrder, status: 'PAID' });
      provider.getClientSecret.mockResolvedValue('secret');

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order.status).toBe('PAID');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('свой заказ без providerIntentId (провайдер тогда не ответил) — повтор довершает: создаёт intent и сохраняет', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...activeOrder, providerIntentId: null });
      provider.createPaymentIntent.mockResolvedValue({
        providerIntentId: 'fake_pi_2',
        clientSecret: 'fake_secret_2',
      });
      prisma.order.updateMany.mockResolvedValue({ count: 1 });
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        ...activeOrder,
        providerIntentId: 'fake_pi_2',
      });

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order.providerIntentId).toBe('fake_pi_2');
      expect(result.clientSecret).toBe('fake_secret_2');
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('двойной клик: другой запрос успел привязать intent раньше — берём его intent, а не свой', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...activeOrder, providerIntentId: null });
      provider.createPaymentIntent.mockResolvedValue({
        providerIntentId: 'fake_pi_loser',
        clientSecret: 'secret_loser',
      });
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // условная привязка не сработала
      prisma.order.findUniqueOrThrow.mockResolvedValue({
        ...activeOrder,
        providerIntentId: 'fake_pi_winner',
      });
      provider.getClientSecret.mockResolvedValue('secret_winner');

      const result = await service.create({ eventId, seatId }, user, authorization);

      expect(result.order.providerIntentId).toBe('fake_pi_winner');
      expect(result.clientSecret).toBe('secret_winner');
      expect(provider.getClientSecret).toHaveBeenCalledWith('fake_pi_winner');
    });

    it('заказ на это место у другого пользователя — 409 сразу, без походов в booking/catalog', async () => {
      prisma.order.findFirst.mockResolvedValue({ ...activeOrder, userId: 'someone-else' });

      await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
        ConflictException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(provider.getClientSecret).not.toHaveBeenCalled();
    });

    describe('гонка: заказ появился между проверкой и вставкой (P2002)', () => {
      const uniqueViolation = () =>
        new Prisma.PrismaClientKnownRequestError('нарушение уникальности', {
          code: 'P2002',
          clientVersion: 'test',
        });

      beforeEach(() => {
        mockHoldResponse({ seatId, expiresAt: '2026-01-01T00:05:00.000Z' });
        mockEventResponse({ status: 'PUBLISHED', basePriceCents: 150000 });
        prisma.order.create.mockRejectedValue(uniqueViolation());
      });

      it('заказ создал тот же пользователь (двойной клик) — возвращаем его', async () => {
        prisma.order.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(activeOrder);
        provider.getClientSecret.mockResolvedValue('secret');

        const result = await service.create({ eventId, seatId }, user, authorization);

        expect(result.order.id).toBe('order-1');
      });

      it('заказ создал другой пользователь — 409', async () => {
        prisma.order.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ ...activeOrder, userId: 'someone-else' });

        await expect(service.create({ eventId, seatId }, user, authorization)).rejects.toThrow(
          ConflictException,
        );
      });
    });
  });

  describe('listByEvent', () => {
    const organizer: AuthenticatedUser = {
      sub: 'org-1',
      email: 'o@seatlock.fun',
      role: 'ORGANIZER',
    };
    const admin: AuthenticatedUser = { sub: 'admin-1', email: 'a@seatlock.fun', role: 'ADMIN' };
    const orders = [{ id: 'order-1', eventId, seatId, status: 'PAID' }];

    it('ORGANIZER — своё событие, видит заказы', async () => {
      mockEventResponse({
        status: 'PUBLISHED',
        basePriceCents: 150000,
        organizerId: organizer.sub,
      });
      prisma.order.findMany.mockResolvedValue(orders);

      const result = await service.listByEvent(eventId, organizer);

      expect(result).toEqual(orders);
      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { eventId },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('ORGANIZER — чужое событие, 403, к БД не ходим', async () => {
      mockEventResponse({
        status: 'PUBLISHED',
        basePriceCents: 150000,
        organizerId: 'other-organizer',
      });

      await expect(service.listByEvent(eventId, organizer)).rejects.toThrow(ForbiddenException);
      expect(prisma.order.findMany).not.toHaveBeenCalled();
    });

    it('ADMIN — видит заказы любого события, даже не своего', async () => {
      mockEventResponse({
        status: 'PUBLISHED',
        basePriceCents: 150000,
        organizerId: 'someone-else',
      });
      prisma.order.findMany.mockResolvedValue(orders);

      const result = await service.listByEvent(eventId, admin);

      expect(result).toEqual(orders);
    });
  });

  describe('listSoldSeatIds', () => {
    it('возвращает seatId только заказов в статусе PAID', async () => {
      prisma.order.findMany.mockResolvedValue([{ seatId: 'seat-1' }, { seatId: 'seat-2' }]);

      const result = await service.listSoldSeatIds(eventId);

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { eventId, status: 'PAID' },
        select: { seatId: true },
      });
      expect(result).toEqual(['seat-1', 'seat-2']);
    });
  });
});
