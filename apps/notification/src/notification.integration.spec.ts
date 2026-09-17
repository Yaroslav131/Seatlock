import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as amqp from 'amqplib';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';
import { NOTIFICATION_DLQ, PAYMENT_EVENTS_EXCHANGE } from './rabbitmq/rabbitmq.module';

// Как и payment.integration.spec.ts — настоящее Nest-приложение поверх
// настоящих Postgres/RabbitMQ/MinIO/Mailpit, auth и catalog подменены
// одним локальным фейковым HTTP-сервером. Единственный способ
// автотестом проверить, что consumer реально долетает от сообщения в
// RabbitMQ до письма в Mailpit и объекта в MinIO, а не просто до мока.
process.env.NOTIFICATION_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=notification';
process.env.RABBITMQ_URL ??= 'amqp://seatlock:seatlock@localhost:5673';
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
  let upstreamState: UpstreamState;
  let prisma: PrismaService;
  let s3: S3Client;

  const userId = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = req.url ?? '';
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
    upstreamState = {
      email: 'buyer@seatlock.fun',
      event: {
        title: 'Тестовый концерт',
        startsAt: '2026-12-01T19:00:00.000Z',
        venueId: 'venue-1',
      },
      venue: { name: 'Дворец спорта', city: 'Минск', address: 'пр. Победителей, 1' },
      seats: [{ id: 'seat-1', section: 'A', row: 3, number: 12 }],
    };
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

    const log = await waitFor(() =>
      prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      }),
    );
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

    const log = await waitFor(() =>
      prisma.notificationLog.findUnique({
        where: { orderId_type: { orderId, type: 'TICKET_EMAIL' } },
      }),
    );
    expect(log.status).toBe('FAILED');
  });
});
