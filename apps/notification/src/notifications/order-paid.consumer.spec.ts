import type * as amqp from 'amqplib';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TicketPdfService } from '../tickets/ticket-pdf.service';
import type { TicketStorageService } from '../tickets/ticket-storage.service';
import { OrderPaidConsumer } from './order-paid.consumer';

function createPrismaMock() {
  return {
    // Захват заказа (INSERT ... ON CONFLICT ... RETURNING): непустой результат — захвачен.
    $queryRaw: jest.fn(),
    notificationLog: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function createConfigMock(values: Record<string, string>) {
  return { getOrThrow: jest.fn((key: string) => values[key]) };
}

function createChannelMock() {
  return { ack: jest.fn(), nack: jest.fn(), consume: jest.fn() };
}

function createMsg(payload: unknown): amqp.ConsumeMessage {
  return { content: Buffer.from(JSON.stringify(payload)) } as unknown as amqp.ConsumeMessage;
}

type PrismaMock = ReturnType<typeof createPrismaMock>;
type ChannelMock = ReturnType<typeof createChannelMock>;

const event = {
  orderId: 'order-1',
  userId: 'user-1',
  eventId: 'event-1',
  seatId: 'seat-1',
  amountCents: 150000,
};

const catalogEvent = { title: 'Концерт', startsAt: '2026-12-01T19:00:00Z', venueId: 'venue-1' };
const venue = { name: 'Дворец спорта', city: 'Минск', address: 'адрес' };
const seats = [{ id: 'seat-1', section: 'A', row: 3, number: 12 }];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('OrderPaidConsumer', () => {
  let prisma: PrismaMock;
  let pdf: jest.Mocked<Pick<TicketPdfService, 'generate'>>;
  let storage: jest.Mocked<Pick<TicketStorageService, 'uploadTicket'>>;
  let mail: jest.Mocked<Pick<MailService, 'sendTicket'>>;
  let channel: ChannelMock;
  let consumer: OrderPaidConsumer;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    prisma = createPrismaMock();
    pdf = { generate: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')) };
    storage = { uploadTicket: jest.fn().mockResolvedValue('tickets/order-1.pdf') };
    mail = { sendTicket: jest.fn().mockResolvedValue(undefined) };
    channel = createChannelMock();
    consumer = new OrderPaidConsumer(
      prisma as unknown as PrismaService,
      createConfigMock({
        AUTH_SERVICE_URL: 'http://auth.local',
        CATALOG_SERVICE_URL: 'http://catalog.local',
      }) as never,
      pdf as unknown as TicketPdfService,
      storage as unknown as TicketStorageService,
      mail as unknown as MailService,
      channel as unknown as amqp.Channel,
    );

    fetchMock = jest.fn((url: string) => {
      if (url.includes('/internal/users/')) {
        return Promise.resolve(jsonResponse({ id: event.userId, email: 'buyer@seatlock.fun' }));
      }
      if (url.includes('/seats')) {
        return Promise.resolve(jsonResponse(seats));
      }
      if (url.includes('/venues/')) {
        return Promise.resolve(jsonResponse(venue));
      }
      if (url.includes('/events/')) {
        return Promise.resolve(jsonResponse(catalogEvent));
      }
      return Promise.resolve(jsonResponse(null, false, 404));
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // По умолчанию заказ свободен и захватывается; ожидание при занятом заказе в тестах не ждём.
    prisma.$queryRaw.mockResolvedValue([{ id: 'log-1' }]);
    jest
      .spyOn(consumer as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  it('уже SENT — сразу ack, без похода за данными', async () => {
    prisma.$queryRaw.mockResolvedValue([]); // захватить нечего
    prisma.notificationLog.findUnique.mockResolvedValue({ status: 'SENT' });

    await consumer.handle(createMsg(event));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendTicket).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('заказ сейчас обрабатывает другой воркер — письмо не шлём, сообщение возвращаем в очередь (не теряем)', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.notificationLog.findUnique.mockResolvedValue({ status: 'PROCESSING' });
    const msg = createMsg(event);

    await consumer.handle(msg);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mail.sendTicket).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, true);
  });

  it('happy path — письмо с PDF отправлено, лог SENT, ack', async () => {
    await consumer.handle(createMsg(event));

    expect(pdf.generate).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: event.orderId, seatRow: 3, seatNumber: 12 }),
    );
    expect(storage.uploadTicket).toHaveBeenCalledWith(event.orderId, expect.any(Buffer));
    expect(mail.sendTicket).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'buyer@seatlock.fun' }),
    );
    expect(prisma.notificationLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', claimedAt: null }),
      }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('catalog недоступен — лог FAILED, nack без реквеста (уходит в DLQ)', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/internal/users/')) {
        return Promise.resolve(jsonResponse({ id: event.userId, email: 'buyer@seatlock.fun' }));
      }
      return Promise.resolve(jsonResponse(null, false, 503));
    });

    await consumer.handle(createMsg(event));

    expect(mail.sendTicket).not.toHaveBeenCalled();
    expect(prisma.notificationLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED', claimedAt: null }),
      }),
    );
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('битое сообщение (невалидный JSON) — сразу nack, Prisma не трогаем', async () => {
    const msg = { content: Buffer.from('not-json') } as unknown as amqp.ConsumeMessage;

    await consumer.handle(msg);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });
});
