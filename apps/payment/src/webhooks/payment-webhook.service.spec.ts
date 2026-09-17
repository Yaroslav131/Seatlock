import { BadRequestException } from '@nestjs/common';
import { OutboxService } from '../outbox/outbox.service';
import { PaymentProviderPort } from '../providers/payment-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentWebhookService } from './payment-webhook.service';

function createPrismaMock() {
  const tx = { order: { update: jest.fn() } };
  return {
    order: { findUnique: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
}

function createConfigMock(values: Record<string, string> = {}) {
  return {
    getOrThrow: jest.fn((key: string) => values[key]),
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  };
}

function createProviderMock(): jest.Mocked<PaymentProviderPort> {
  return {
    createPaymentIntent: jest.fn(),
    verifyWebhookSignature: jest.fn(),
    refund: jest.fn(),
  };
}

type PrismaMock = ReturnType<typeof createPrismaMock>;

const providerIntentId = 'fake_pi_1';
const pendingOrder = {
  id: 'order-1',
  eventId: 'event-1',
  seatId: 'seat-1',
  userId: 'user-1',
  amountCents: 150000,
  status: 'PENDING' as const,
  providerIntentId,
};
const paidOrder = { ...pendingOrder, status: 'PAID' as const };

describe('PaymentWebhookService', () => {
  let prisma: PrismaMock;
  let outbox: jest.Mocked<Pick<OutboxService, 'record'>>;
  let provider: jest.Mocked<PaymentProviderPort>;
  let service: PaymentWebhookService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = { record: jest.fn() };
    provider = createProviderMock();
    service = new PaymentWebhookService(
      prisma as unknown as PrismaService,
      createConfigMock({
        BOOKING_SERVICE_URL: 'http://booking.local',
        JWT_ACCESS_SECRET: 'test-secret',
      }) as never,
      outbox as unknown as OutboxService,
      provider,
    );
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('невалидная подпись — 400, ничего не трогаем', async () => {
    provider.verifyWebhookSignature.mockReturnValue(null);

    await expect(service.handle(Buffer.from('{}'), 'bad-sig')).rejects.toThrow(BadRequestException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('payment.succeeded переводит PENDING-заказ в PAID и пишет outbox ровно один раз', async () => {
    provider.verifyWebhookSignature.mockReturnValue({
      type: 'payment.succeeded',
      providerIntentId,
    });
    prisma.order.findUnique.mockResolvedValue(pendingOrder);

    await service.handle(Buffer.from('{}'), 'sig');

    expect(prisma.__tx.order.update).toHaveBeenCalledWith({
      where: { id: pendingOrder.id },
      data: { status: 'PAID' },
    });
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(
      expect.anything(),
      'order.paid',
      expect.objectContaining({ orderId: pendingOrder.id, amountCents: pendingOrder.amountCents }),
    );
  });

  it('повторная доставка payment.succeeded для уже PAID-заказа — идемпотентна, не пишет outbox снова', async () => {
    provider.verifyWebhookSignature.mockReturnValue({
      type: 'payment.succeeded',
      providerIntentId,
    });
    prisma.order.findUnique.mockResolvedValue(paidOrder);

    await service.handle(Buffer.from('{}'), 'sig');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('payment.failed гасит ещё PENDING заказ в CANCELLED', async () => {
    provider.verifyWebhookSignature.mockReturnValue({ type: 'payment.failed', providerIntentId });
    prisma.order.findUnique.mockResolvedValue(pendingOrder);

    await service.handle(Buffer.from('{}'), 'sig');

    expect(prisma.__tx.order.update).toHaveBeenCalledWith({
      where: { id: pendingOrder.id },
      data: { status: 'CANCELLED' },
    });
  });

  it('payment.failed не трогает уже PAID заказ (не откатывает успешную оплату)', async () => {
    provider.verifyWebhookSignature.mockReturnValue({ type: 'payment.failed', providerIntentId });
    prisma.order.findUnique.mockResolvedValue(paidOrder);

    await service.handle(Buffer.from('{}'), 'sig');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('вебхук на неизвестный providerIntentId — не падает, просто ничего не делает', async () => {
    provider.verifyWebhookSignature.mockReturnValue({
      type: 'payment.succeeded',
      providerIntentId: 'ghost',
    });
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.handle(Buffer.from('{}'), 'sig')).resolves.toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
