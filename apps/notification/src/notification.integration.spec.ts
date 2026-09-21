import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as amqp from 'amqplib';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from './app.module';
import { replayDeadLetters } from './dlq/replay-dead-letters';
import { MailService } from './mail/mail.service';
import { OrderPaidConsumer } from './notifications/order-paid.consumer';
import { TicketStorageService } from './tickets/ticket-storage.service';
import { PrismaService } from './prisma/prisma.service';
import {
  NOTIFICATION_DLQ,
  PAYMENT_EVENTS_EXCHANGE,
  RABBITMQ_CHANNEL,
} from './rabbitmq/rabbitmq.module';

// Как и payment.integration.spec.ts — настоящее Nest-приложение поверх
// настоящих Postgres/RabbitMQ/MinIO/Mailpit, auth и catalog подменены
// одним локальным фейковым HTTP-сервером. Единственный способ
// автотестом проверить, что consumer реально долетает от сообщения в
// RabbitMQ до письма в Mailpit и объекта в MinIO, а не просто до мока.
process.env.NOTIFICATION_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=notification';
process.env.RABBITMQ_URL ??= 'amqp://seatlock:seatlock@localhost:5673';
// Несколько писем в работе одновременно: заодно все тесты файла идут при prefetch > 1.
process.env.NOTIFICATION_PREFETCH ??= '3';
process.env.S3_ENDPOINT ??= 'http://localhost:9100';
process.env.S3_ACCESS_KEY ??= 'seatlock';
process.env.S3_SECRET_KEY ??= 'seatlock123';
process.env.S3_BUCKET ??= 'seatlock-tickets';
process.env.SMTP_HOST ??= 'localhost';
process.env.SMTP_PORT ??= '1026';

const MAILPIT_API = 'http://localhost:8026/api/v1';

interface UpstreamState {
  email: string;
  event: { title: string; startsAt: string; venueId: string } | null;
  venue: { name: string; city: string; address: string };
  seats: Array<{ id: string; section: string | null; row: number; number: number }>;
  /** URL всех запросов, дошедших до фейкового catalog/auth (снимок билета должен обходиться без них). */
  requestedUrls: string[];
}

function defaultUpstreamState(): UpstreamState {
  return {
    email: 'buyer@seatlock.fun',
    event: { title: 'Тестовый концерт', startsAt: '2026-12-01T19:00:00.000Z', venueId: 'venue-1' },
    venue: { name: 'Дворец спорта', city: 'Минск', address: 'пр. Победителей, 1' },
    seats: [{ id: 'seat-1', section: 'A', row: 3, number: 12 }],
    requestedUrls: [],
  };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('waitFor: условие не выполнилось за отведённое время');
}

describe('notification (интеграция, настоящий Nest + Postgres + RabbitMQ + MinIO + Mailpit)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let upstream: http.Server;
  // Инициализируем сразу: consumer начинает разбирать очередь при старте приложения,
  // раньше первого beforeEach, и в очереди могут лежать сообщения других прогонов.
  let upstreamState: UpstreamState = defaultUpstreamState();
  let prisma: PrismaService;
  let s3: S3Client;

  const userId = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = req.url ?? '';
      upstreamState.requestedUrls.push(url);
      if (req.method === 'GET' && url.includes('/internal/users/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: userId, email: upstreamState.email }));
        return;
      }
      if (req.method === 'GET' && url.includes('/seats')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamState.seats));
        return;
      }
      if (req.method === 'GET' && url.includes('/venues/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamState.venue));
        return;
      }
      if (req.method === 'GET' && url.includes('/events/')) {
        if (!upstreamState.event) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamState.event));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
    process.env.AUTH_SERVICE_URL = upstreamUrl;
    process.env.CATALOG_SERVICE_URL = upstreamUrl;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // onApplicationBootstrap (запуск consumer'а) срабатывает уже на init(),
    // отдельный listen() для этого не нужен — у сервиса нет HTTP-путей,
    // которые проверяет этот тест.
    await app.init();
    prisma = app.get(PrismaService);

    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY!,
        secretAccessKey: process.env.S3_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  });

  beforeEach(async () => {
    upstreamState = defaultUpstreamState();
    await prisma.notificationLog.deleteMany();
    await fetch(`${MAILPIT_API}/messages`, { method: 'DELETE' });
  });

  afterAll(async () => {
    await prisma.notificationLog.deleteMany();
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    // Без этого держит keep-alive сокет открытым и Jest не выходит
    // после прогона (свой S3Client теста, не тот, что внутри
    // TicketStorageService — тот закрывается вместе с app.close()).
    s3.destroy();
  });

  it('order.paid → письмо с PDF в Mailpit, объект в MinIO, лог SENT', async () => {
    const orderId = 'order-happy-1';
    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    const channel = await connection.createChannel();
    channel.publish(
      PAYMENT_EVENTS_EXCHANGE,
      'order.paid',
      Buffer.from(
        JSON.stringify({
          orderId,
          userId,
          eventId: 'event-1',
          seatId: 'seat-1',
          amountCents: 150000,
        }),
      ),
      { persistent: true, contentType: 'application/json' },
    );
    await channel.close();
    await connection.close();

    // Строка лога появляется сразу со статусом PROCESSING (захват заказа) — ждём итог.
    const log = await waitFor(async () => {
      const row = await prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      });
      return row && row.status !== 'PROCESSING' ? row : null;
    });
    expect(log.status).toBe('SENT');
    expect(log.pdfKey).toBe(`tickets/${orderId}.pdf`);

    const s3Object = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `tickets/${orderId}.pdf` }),
    );
    expect(s3Object.ContentLength).toBeGreaterThan(0);

    const mailpitMessages = (await (await fetch(`${MAILPIT_API}/messages`)).json()) as {
      messages: Array<{ To: Array<{ Address: string }>; Attachments: number }>;
    };
    const delivered = mailpitMessages.messages.find((m) =>
      m.To.some((to) => to.Address === upstreamState.email),
    );
    expect(delivered).toBeDefined();
    expect(delivered?.Attachments).toBeGreaterThan(0);
  });

  it('catalog не находит событие → сообщение уходит в DLQ, лог FAILED', async () => {
    const orderId = 'order-dlq-1';
    upstreamState.event = null; // catalog ответит 404

    const dlqConsumer = await amqp.connect(process.env.RABBITMQ_URL!);
    const dlqChannel = await dlqConsumer.createChannel();
    await dlqChannel.purgeQueue(NOTIFICATION_DLQ);
    const dlqDelivery = new Promise<amqp.ConsumeMessage>((resolve) => {
      void dlqChannel.consume(NOTIFICATION_DLQ, (msg) => {
        if (msg) resolve(msg);
      });
    });

    const publishConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    const publishChannel = await publishConnection.createChannel();
    publishChannel.publish(
      PAYMENT_EVENTS_EXCHANGE,
      'order.paid',
      Buffer.from(
        JSON.stringify({
          orderId,
          userId,
          eventId: 'missing-event',
          seatId: 'seat-1',
          amountCents: 150000,
        }),
      ),
      { persistent: true, contentType: 'application/json' },
    );
    await publishChannel.close();
    await publishConnection.close();

    const dlqMessage = await dlqDelivery;
    const dlqPayload = JSON.parse(dlqMessage.content.toString('utf-8')) as { orderId: string };
    expect(dlqPayload.orderId).toBe(orderId);
    dlqChannel.ack(dlqMessage);
    await dlqChannel.close();
    await dlqConsumer.close();

    // Строка лога появляется сразу со статусом PROCESSING (захват заказа) — ждём итог.
    const log = await waitFor(async () => {
      const row = await prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      });
      return row && row.status !== 'PROCESSING' ? row : null;
    });
    expect(log.status).toBe('FAILED');
  });

  it('order.paid со снимком билета: PDF, объект в MinIO и лог SENT без единого запроса к catalog и auth', async () => {
    const orderId = 'order-snapshot-1';
    // Уникальные id: параллельные тесты других пакетов могут гонять через тот же
    // consumer свои сообщения и обращаться к фейковому catalog/auth — считаем
    // только запросы, относящиеся к нашему заказу.
    const snapshotEventId = 'event-snapshot-1';
    const snapshotUserId = '44444444-4444-4444-8444-444444444444';
    const email = `snapshot-${Date.now()}@seatlock.fun`;
    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    const channel = await connection.createChannel();
    channel.publish(
      PAYMENT_EVENTS_EXCHANGE,
      'order.paid',
      Buffer.from(
        JSON.stringify({
          orderId,
          userId: snapshotUserId,
          eventId: snapshotEventId,
          seatId: 'seat-1',
          amountCents: 150000,
          ticket: {
            buyerEmail: email,
            eventTitle: 'Концерт из снимка',
            startsAt: '2026-12-01T19:00:00.000Z',
            venueName: 'Дворец спорта',
            venueCity: 'Минск',
            venueAddress: 'пр. Победителей, 1',
            seatSection: 'A',
            seatRow: 3,
            seatNumber: 12,
          },
        }),
      ),
      { persistent: true, contentType: 'application/json' },
    );
    await channel.close();
    await connection.close();

    const log = await waitFor(async () => {
      const row = await prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      });
      return row && row.status !== 'PROCESSING' ? row : null;
    });
    expect(log.status).toBe('SENT');
    expect(log.pdfKey).toBe(`tickets/${orderId}.pdf`);

    const s3Object = await s3.send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `tickets/${orderId}.pdf` }),
    );
    expect(s3Object.ContentLength).toBeGreaterThan(0);

    const mailpitMessages = (await (await fetch(`${MAILPIT_API}/messages`)).json()) as {
      messages: Array<{ To: Array<{ Address: string }> }>;
    };
    expect(mailpitMessages.messages.some((m) => m.To.some((to) => to.Address === email))).toBe(
      true,
    );
    // К catalog и auth по этому заказу никто не ходил.
    const ownRequests = upstreamState.requestedUrls.filter(
      (url) => url.includes(snapshotEventId) || url.includes(snapshotUserId),
    );
    expect(ownRequests).toEqual([]);
  });

  it('prefetch > 1: несколько заказов обрабатываются одновременно, письмо на каждый ровно одно', async () => {
    const mail = app.get(MailService);
    const originalSend = mail.sendTicket.bind(mail);
    let inFlight = 0;
    let maxInFlight = 0;
    const sendSpy = jest.spyOn(mail, 'sendTicket').mockImplementation(async (email) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await originalSend(email);
      } finally {
        inFlight -= 1;
      }
    });

    const runId = Date.now();
    const orders = Array.from({ length: 3 }, (_, i) => ({
      orderId: `order-prefetch-${runId}-${i}`,
      email: `prefetch-${runId}-${i}@seatlock.fun`,
    }));
    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    const channel = await connection.createChannel();
    for (const { orderId, email } of orders) {
      channel.publish(
        PAYMENT_EVENTS_EXCHANGE,
        'order.paid',
        Buffer.from(
          JSON.stringify({
            orderId,
            userId,
            eventId: 'event-1',
            seatId: 'seat-1',
            amountCents: 150000,
            ticket: {
              buyerEmail: email,
              eventTitle: 'Параллельная обработка',
              startsAt: '2026-12-01T19:00:00.000Z',
              venueName: 'Дворец спорта',
              venueCity: 'Минск',
              venueAddress: 'пр. Победителей, 1',
              seatSection: null,
              seatRow: 1,
              seatNumber: 1,
            },
          }),
        ),
        { persistent: true, contentType: 'application/json' },
      );
    }
    await channel.close();
    await connection.close();

    try {
      for (const { orderId } of orders) {
        const log = await waitFor(async () => {
          const row = await prisma.notificationLog.findUnique({
            where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
          });
          return row && row.status !== 'PROCESSING' ? row : null;
        }, 25_000);
        expect(log.status).toBe('SENT');
      }
    } finally {
      sendSpy.mockRestore();
    }

    // Отправки перекрывались во времени — иначе prefetch не даёт выигрыша.
    expect(maxInFlight).toBeGreaterThan(1);
    const mailpit = (await (await fetch(`${MAILPIT_API}/messages`)).json()) as {
      messages: Array<{ To: Array<{ Address: string }> }>;
    };
    for (const { email } of orders) {
      const delivered = mailpit.messages.filter((m) => m.To.some((to) => to.Address === email));
      expect(delivered).toHaveLength(1);
    }
  });

  it('два воркера одновременно берут один и тот же заказ: письмо одно (атомарный захват)', async () => {
    const consumer = app.get(OrderPaidConsumer);
    const channel = app.get<amqp.Channel>(RABBITMQ_CHANNEL);
    // Сообщение синтетическое (без настоящей доставки от брокера), поэтому
    // ack/nack подменяем: считаем, что решил каждый из двух обработчиков.
    const ack = jest.spyOn(channel, 'ack').mockImplementation(() => undefined);
    const nack = jest.spyOn(channel, 'nack').mockImplementation(() => undefined);
    // Чужие order.paid (тесты других пакетов на том же RabbitMQ) может разбирать тот
    // же consumer, поэтому считаем только вызовы по нашему заказу: загрузка PDF
    // происходит ровно один раз на захваченный заказ, до отправки письма.
    const upload = jest.spyOn(app.get(TicketStorageService), 'uploadTicket');
    const orderId = 'order-race-1';
    const msg = {
      content: Buffer.from(
        JSON.stringify({
          orderId,
          userId,
          eventId: 'event-1',
          seatId: 'seat-1',
          amountCents: 150000,
        }),
      ),
    } as amqp.ConsumeMessage;

    // mockRestore() сбрасывает историю вызовов, поэтому снимаем её до восстановления.
    const { ackCount, nackCalls, uploads } = await Promise.all([
      consumer.handle(msg),
      consumer.handle(msg),
    ])
      .then(() => ({
        ackCount: ack.mock.calls.filter((call) => call[0] === msg).length,
        nackCalls: nack.mock.calls.filter((call) => call[0] === msg),
        uploads: upload.mock.calls.filter((call) => call[0] === orderId).length,
      }))
      .finally(() => {
        ack.mockRestore();
        nack.mockRestore();
        upload.mockRestore();
      });

    const log = await prisma.notificationLog.findUniqueOrThrow({
      where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
    });
    expect(log.status).toBe('SENT');

    // Письмо отправляется только после загрузки PDF, а загрузка прошла ровно один раз:
    // значит и письмо по этому заказу ушло одно.
    expect(uploads).toBe(1);

    // Оба обработчика приняли решение: один отправил и подтвердил, второй либо
    // увидел SENT и подтвердил дубль, либо вернул сообщение в очередь, не теряя его.
    expect(ackCount + nackCalls.length).toBe(2);
    for (const call of nackCalls) {
      expect(call).toEqual([msg, false, true]);
    }
  });

  it('повторная отправка из DLQ: сообщение возвращается в работу, FAILED-заказ доходит до SENT', async () => {
    const orderId = 'order-replay-1';
    await prisma.notificationLog.create({
      data: {
        orderId,
        type: 'TICKET_EMAIL',
        status: 'FAILED',
        errorMessage: 'catalog вернул 503',
      },
    });

    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    const channel = await connection.createConfirmChannel();
    await channel.purgeQueue(NOTIFICATION_DLQ);
    channel.sendToQueue(
      NOTIFICATION_DLQ,
      Buffer.from(
        JSON.stringify({
          orderId,
          userId,
          eventId: 'event-1',
          seatId: 'seat-1',
          amountCents: 150000,
        }),
      ),
      { persistent: true },
    );
    await channel.waitForConfirms();

    // dry-run показывает сообщение, но не переносит его.
    const dry = await replayDeadLetters(channel, { limit: 10, dryRun: true });
    expect(dry.orderIds).toEqual([orderId]);
    expect((await channel.checkQueue(NOTIFICATION_DLQ)).messageCount).toBe(1);

    const result = await replayDeadLetters(channel, { limit: 10, dryRun: false });
    expect(result.processed).toBe(1);

    const log = await waitFor(async () => {
      const row = await prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      });
      return row?.status === 'SENT' ? row : null;
    });
    expect(log.errorMessage).toBeNull();
    expect((await channel.checkQueue(NOTIFICATION_DLQ)).messageCount).toBe(0);

    await channel.close();
    await connection.close();
  });

  it('GET /metrics — отдаёт метрики в формате Prometheus', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toContain('# TYPE order_paid_processed_total counter');
    expect(res.text).toContain('# TYPE notification_order_paid_queue_messages gauge');
    expect(res.text).toContain('# TYPE ticket_mail_suppressed_total counter');
  });
});
