import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './app.module';
import { OutboxPublisherService } from './outbox/outbox-publisher.service';
import { PrismaService } from './prisma/prisma.service';
import { PAYMENT_EVENTS_EXCHANGE } from './rabbitmq/rabbitmq.module';

// В отличие от orders.service.spec.ts/payment-webhook.service.spec.ts
// (моки Prisma/провайдера/fetch), этот файл поднимает настоящее
// Nest-приложение поверх настоящих Postgres и RabbitMQ и бьёт через
// supertest — единственный способ проверить автотестом, что частичный
// уникальный индекс (вручную дописанный в migration.sql, см.
// schema.prisma) реально отклоняет конкурентный заказ на Postgres, и
// что outbox-паблишер реально доставляет сообщение в RabbitMQ, а не
// просто проставляет publishedAt локально. booking/catalog подменены
// одним локальным фейковым HTTP-сервером — тем же паттерном, что уже
// использует gateway's main.integration.spec.ts.
process.env.PAYMENT_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=payment';
process.env.RABBITMQ_URL ??= 'amqp://seatlock:seatlock@localhost:5673';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-payment-integration';
process.env.PAYMENT_PROVIDER ??= 'fake';

function signToken(sub: string): string {
  return jwt.sign(
    { sub, email: `${sub}@seatlock.fun`, role: 'USER' },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: '15m' },
  );
}

interface UpstreamState {
  hold: { seatId: string; expiresAt: string } | null;
  event: { status: string; basePriceCents: number };
}

describe('payment (интеграция, настоящий Nest + настоящий Postgres + RabbitMQ)', () => {
  jest.setTimeout(30_000);

  let app: NestExpressApplication;
  let upstream: http.Server;
  let upstreamState: UpstreamState;
  let releaseHoldCalls: number;
  let prisma: PrismaService;

  // CreateOrderDto валидирует eventId как UUID (в отличие от booking,
  // где eventId — просто параметр URL без валидации) — реальные id
  // событий в catalog как раз @default(uuid()).
  const eventId = '22222222-2222-4222-8222-222222222222';
  const seatId = '11111111-1111-4111-8111-111111111111';

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/my-hold')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // Пустое тело на null — тот же контракт, что и у настоящего
        // booking (см. holds.controller.ts), а не JSON null.
        res.end(upstreamState.hold ? JSON.stringify(upstreamState.hold) : '');
        return;
      }
      if (req.method === 'DELETE' && url.endsWith('/holds')) {
        releaseHoldCalls += 1;
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.includes('/api/catalog/events/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamState.event));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
    process.env.BOOKING_SERVICE_URL = upstreamUrl;
    process.env.CATALOG_SERVICE_URL = upstreamUrl;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    // Ровно то же, что и настоящий main.ts — иначе тест проверяет не то
    // приложение, что реально едет в прод.
    app.set('trust proxy', true);
    app.setGlobalPrefix('api/payment', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    upstreamState = {
      hold: { seatId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() },
      event: { status: 'PUBLISHED', basePriceCents: 150000 },
    };
    releaseHoldCalls = 0;
    await prisma.outboxEvent.deleteMany();
    await prisma.order.deleteMany();
  });

  afterAll(async () => {
    await prisma.order.deleteMany();
    await prisma.outboxEvent.deleteMany();
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('POST /orders без токена — 401', async () => {
    await request(app.getHttpServer())
      .post('/api/payment/orders')
      .send({ eventId, seatId })
      .expect(401);
  });

  it('нет холда на это место — 403, заказ не создаётся', async () => {
    upstreamState.hold = null;
    const token = signToken('user-1');

    await request(app.getHttpServer())
      .post('/api/payment/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ eventId, seatId })
      .expect(403);

    expect(await prisma.order.count()).toBe(0);
  });

  it('второй заказ на то же место, пока первый ещё PENDING — 409 (частичный уникальный индекс Postgres)', async () => {
    const tokenA = signToken('user-a');
    const tokenB = signToken('user-b');

    await request(app.getHttpServer())
      .post('/api/payment/orders')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ eventId, seatId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/payment/orders')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ eventId, seatId })
      .expect(409);

    expect(await prisma.order.count({ where: { status: 'PENDING' } })).toBe(1);
  });

  it('полный цикл: заказ → fake-webhook payment.succeeded → PAID в БД → Redis-холд погашен → событие реально доставлено в RabbitMQ', async () => {
    const token = signToken('user-1');

    const createRes = await request(app.getHttpServer())
      .post('/api/payment/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ eventId, seatId })
      .expect(201);

    const { id: orderId, providerIntentId } = createRes.body as {
      id: string;
      providerIntentId: string;
    };
    expect(providerIntentId).toEqual(expect.stringMatching(/^fake_pi_/));

    // Готовим тестовую очередь ДО того, как что-либо публикуется —
    // иначе можем поймать гонку и пропустить сообщение.
    const rabbitConnection = await amqp.connect(process.env.RABBITMQ_URL!);
    const rabbitChannel = await rabbitConnection.createChannel();
    const { queue } = await rabbitChannel.assertQueue('', { exclusive: true });
    await rabbitChannel.bindQueue(queue, PAYMENT_EVENTS_EXCHANGE, 'order.paid');
    const delivery = new Promise<amqp.ConsumeMessage>((resolve) => {
      void rabbitChannel.consume(queue, (msg) => {
        if (msg) resolve(msg);
      });
    });

    await request(app.getHttpServer())
      .post('/api/payment/dev/fake-webhook')
      .send({ providerIntentId, type: 'payment.succeeded' })
      .expect(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAID');
    expect(releaseHoldCalls).toBe(1);

    // Паблишер публикует по расписанию (@Interval, см.
    // outbox-publisher.service.ts) — в тесте не ждём реальные 5 секунд,
    // дёргаем тот же метод напрямую, ровно как это сделал бы тик таймера.
    const publisher = app.get(OutboxPublisherService);
    await publisher.publishPending();

    const message = await delivery;
    const payload = JSON.parse(message.content.toString('utf-8')) as { orderId: string };
    expect(payload.orderId).toBe(orderId);
    rabbitChannel.ack(message);
    await rabbitChannel.close();
    await rabbitConnection.close();

    const outboxRow = await prisma.outboxEvent.findFirst({ where: { eventType: 'order.paid' } });
    expect(outboxRow?.publishedAt).not.toBeNull();
  });
});
