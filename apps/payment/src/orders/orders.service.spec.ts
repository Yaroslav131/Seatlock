import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { Prisma } from '../generated/prisma';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';

function createPrismaMock() {
  return {
    order: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
  };
}

function createConfigMock(values: Record<string, string>) {
  return { getOrThrow: jest.fn((key: string) => values[key]) };
}

function createProviderMock(): jest.Mocked<PaymentProviderPort> {
  return {
    createPaymentIntent: jest.fn(),
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
  });

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
      prisma.order.update.mockResolvedValue({
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
