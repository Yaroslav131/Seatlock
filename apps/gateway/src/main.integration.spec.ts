import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type Redis from 'ioredis';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './app.module';
import { REDIS_CLIENT } from './infra/tokens';
import { RATE_POLICIES } from './rate-limit/policies';
import { configureApp } from './setup';

// Приложение собирается тем же configureApp, что и в main.ts, поэтому тест проверяет
// именно то, что едет в прод: порядок слоёв (request-id, лимит, прокси, парсер тела),
// список публичных маршрутов, таймауты, кеш. Апстримы auth/catalog/booking/payment
// подменены одним локальным фейковым HTTP-сервером. Это единственный способ поймать
// автотестом баг с bodyParser/pathFilter (пустое тело улетало на сервис), который
// уже ловили руками в браузере.
process.env.DATABASE_URL ??= 'postgresql://seatlock:seatlock@localhost:5433/seatlock';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-gateway-integration';
// Короткий таймаут, чтобы тесты на «сервис завис» шли доли секунды.
process.env.UPSTREAM_TIMEOUT_MS = '400';

// Дольше таймаута gateway: сервис «завис».
const HANG_MS = 700;

function signToken(sub: string): string {
  return jwt.sign(
    { sub, email: `${sub}@seatlock.fun`, role: 'USER' },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: '15m' },
  );
}

interface UpstreamRequest {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

describe('gateway (интеграция: прокси, allowlist, таймауты, лимит, кеш, seat-status)', () => {
  jest.setTimeout(20_000);

  let app: NestExpressApplication;
  let redis: Redis;
  let upstream: http.Server;
  let upstreamRequests: UpstreamRequest[];

  const upstreamCalls = (pathPart: string): UpstreamRequest[] =>
    upstreamRequests.filter((r) => r.url.includes(pathPart));

  beforeAll(async () => {
    upstreamRequests = [];
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      req.on('end', () => {
        const url = req.url!;
        const path = url.split('?')[0];
        upstreamRequests.push({ method: req.method!, url, body, headers: req.headers });

        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(payload === undefined ? '' : JSON.stringify(payload));
        };

        // Сервис оборвал соединение (упал посреди ответа).
        if (path.includes('/boom/')) {
          req.socket.destroy();
          return;
        }
        // Сервис завис: отвечает позже таймаута gateway. Успевает ли ответ
        // дойти до клиента, зависит от того, ограничен ли путь по времени.
        if (path.includes('slow') || url.includes('delay=')) {
          setTimeout(() => json(200, { upstream: true, slow: true }), HANG_MS);
          return;
        }
        if (path.includes('coalesce')) {
          setTimeout(() => json(200, { upstream: true }), 150);
          return;
        }
        if (path.includes('/events/missing')) {
          json(404, { message: 'Событие не найдено' });
          return;
        }
        // seat-status: booking и payment
        if (/\/api\/booking\/events\/[^/]+\/holds$/.test(path) && req.method === 'GET') {
          json(200, [{ seatId: 'A-1' }]);
          return;
        }
        if (/\/api\/booking\/events\/[^/]+\/my-hold$/.test(path)) {
          const auth = req.headers.authorization;
          if (auth === 'Bearer expired') {
            json(401, { message: 'Недействительный access-токен' });
          } else if (auth === 'Bearer nohold') {
            json(200, undefined);
          } else {
            json(200, { seatId: 'A-1', expiresAt: '2026-12-01T12:00:00.000Z' });
          }
          return;
        }
        if (/\/api\/payment\/events\/[^/]+\/sold-seats$/.test(path)) {
          json(200, [{ seatId: 'B-2' }]);
          return;
        }
        json(200, { upstream: true });
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
    process.env.AUTH_SERVICE_URL = upstreamUrl;
    process.env.CATALOG_SERVICE_URL = upstreamUrl;
    process.env.BOOKING_SERVICE_URL = upstreamUrl;
    process.env.PAYMENT_SERVICE_URL = upstreamUrl;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app, app.get(ConfigService));
    await app.init();
    redis = app.get<Redis>(REDIS_CLIENT);
  });

  beforeEach(async () => {
    upstreamRequests.length = 0;
    // Счётчики лимита живут в общем Redis и переживают прогон: чистим свои ключи.
    const keys = await redis.keys('rl:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  describe('прокси', () => {
    it('POST /api/auth/... с непустым телом долетает до апстрима нетронутым (регресс на bodyParser)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'a@b.com', password: 'secret' })
        .expect(200);

      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0].method).toBe('POST');
      expect(upstreamRequests[0].url).toBe('/api/auth/login');
      expect(JSON.parse(upstreamRequests[0].body)).toEqual({
        email: 'a@b.com',
        password: 'secret',
      });
    });

    it('GET /api/catalog/... проксируется на свой апстрим с тем же путём', async () => {
      await request(app.getHttpServer()).get('/api/catalog/events').expect(200);

      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]).toMatchObject({ method: 'GET', url: '/api/catalog/events' });
    });

    it('тело вебхука провайдера долетает до payment байт в байт (подпись считается по сырым байтам)', async () => {
      const raw = '{"type":"payment.succeeded",  "id":"evt_1"}';
      await request(app.getHttpServer())
        .post('/api/payment/webhooks/provider')
        .set('content-type', 'application/json')
        .send(raw)
        .expect(200);

      expect(upstreamRequests[0].body).toBe(raw);
    });

    it('GET /api/me с валидным JWT отвечает сам, не ходит в апстрим', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${signToken('user-1')}`)
        .expect(200);

      expect(res.body).toMatchObject({
        sub: 'user-1',
        email: 'user-1@seatlock.fun',
        role: 'USER',
      });
      expect(upstreamRequests).toHaveLength(0);
    });

    it('GET /api/me без токена — 401, не ходит в апстрим', async () => {
      await request(app.getHttpServer()).get('/api/me').expect(401);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('GET /health — вне префикса /api, отвечает без апстрима', async () => {
      await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      expect(upstreamRequests).toHaveLength(0);
    });

    it('GET /metrics — отдаёт метрики в формате Prometheus, включая новые метрики gateway', async () => {
      const res = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.text).toContain('# TYPE process_cpu_seconds_total counter');
      expect(res.text).toContain('# TYPE gateway_rate_limited_total counter');
      expect(res.text).toContain('# TYPE gateway_cache_total counter');
    });
  });

  describe('список публичных маршрутов', () => {
    it('внутренний эндпоинт catalog для payment наружу не публикуется: 404 без похода в сервис', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/catalog/events/e1/seats/s1/ticket-info')
        .expect(404);

      expect(res.body).toMatchObject({ statusCode: 404 });
      expect(upstreamRequests).toHaveLength(0);
    });

    it.each([
      ['GET', '/api/payment/unknown'],
      ['GET', '/api/auth/internal/users/u1'],
      ['DELETE', '/api/catalog/events/e1'],
      ['GET', '/api/catalog/events/e1%2Fseats%2Fs1%2Fticket-info'],
    ])('%s %s — 404, сервис не тронут', async (method, path) => {
      await request(app.getHttpServer())
        [method.toLowerCase() as 'get' | 'delete'](path)
        .expect(404);
      expect(upstreamRequests).toHaveLength(0);
    });
  });

  describe('request-id', () => {
    it('без заголовка gateway выдаёт id, возвращает его клиенту и передаёт сервису', async () => {
      const res = await request(app.getHttpServer()).get('/api/catalog/venues').expect(200);
      const id = res.headers['x-request-id'];

      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(upstreamRequests[0].headers['x-request-id']).toBe(id);
    });

    it('безопасный клиентский id сохраняется сквозным, небезопасный заменяется', async () => {
      const kept = await request(app.getHttpServer())
        .get('/api/catalog/venues')
        .set('x-request-id', 'client-abc-12345')
        .expect(200);
      expect(kept.headers['x-request-id']).toBe('client-abc-12345');
      expect(upstreamRequests[0].headers['x-request-id']).toBe('client-abc-12345');

      const replaced = await request(app.getHttpServer())
        .get('/api/catalog/venues')
        .set('x-request-id', '<bad>')
        .expect(200);
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('таймауты: только там, где деньги ещё не тронуты', () => {
    it('кешируемый маршрут: сервис завис — 504 за время таймаута, а не через HANG_MS', async () => {
      const startedAt = Date.now();
      const res = await request(app.getHttpServer())
        .get('/api/catalog/events/slow-event')
        .expect(504);

      expect(res.body).toMatchObject({ statusCode: 504 });
      expect(Date.now() - startedAt).toBeLessThan(HANG_MS);
    });

    it('обычный проксируемый маршрут: сервис завис — 504', async () => {
      const startedAt = Date.now();
      await request(app.getHttpServer()).get('/api/payment/orders?delay=1').expect(504);
      expect(Date.now() - startedAt).toBeLessThan(HANG_MS);
    });

    it('создание заказа (деньги ещё не списаны) ограничено по времени', async () => {
      await request(app.getHttpServer()).post('/api/payment/orders?delay=1').send({}).expect(504);
    });

    it('возврат денег НЕ обрывается по таймауту: ответ приходит, хотя сервис ответил позже таймаута', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/payment/orders/o1/refund?delay=1')
        .expect(200);
      expect(res.body).toMatchObject({ slow: true });
    });

    it('вебхук платёжного провайдера НЕ обрывается по таймауту', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/payment/webhooks/provider?delay=1')
        .send({ type: 'payment.succeeded' })
        .expect(200);
      expect(res.body).toMatchObject({ slow: true });
    });

    it('сервис оборвал соединение — быстрый 502, а не 504', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/booking/events/boom/holds')
        .expect(502);
      expect(res.body).toMatchObject({ statusCode: 502 });
    });
  });

  describe('лимит частоты (Redis)', () => {
    const { limit } = RATE_POLICIES.credentials;

    it('вход сверх лимита с одного IP за минуту — 429 с Retry-After; другой IP не затронут', async () => {
      const login = (ip: string) =>
        request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email: 'a@b.com', password: 'x' });

      for (let i = 0; i < limit; i += 1) {
        await login('198.51.100.10').expect(200);
      }
      const limited = await login('198.51.100.10').expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.body).toMatchObject({ statusCode: 429 });
      // запрос сверх лимита до сервиса не дошёл
      expect(upstreamCalls('/api/auth/login')).toHaveLength(limit);

      await login('198.51.100.11').expect(200);
    });

    it('окно счётчика ограничено по времени (ключ не остаётся в Redis навсегда)', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', '198.51.100.20')
        .send({})
        .expect(200);

      const ttl = await redis.pttl('rl:credentials:198.51.100.20');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });

    it('IP берётся из X-Forwarded-For один раз (подделка левой записью не даёт обойти лимит)', async () => {
      // Цепочка "подделка, реальный клиент": при одном доверенном прокси верна только
      // последняя запись, поэтому счётчик общий, как бы ни менялась левая часть.
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-Forwarded-For', `10.0.0.${i}, 198.51.100.30`)
          .send({})
          .expect(200);
      }
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', '10.9.9.9, 198.51.100.30')
        .send({})
        .expect(429);
    });
  });

  describe('кеш публичных GET каталога', () => {
    it('второй запрос отдаётся из кеша: сервис вызван один раз, заголовок x-cache', async () => {
      const first = await request(app.getHttpServer())
        .get('/api/catalog/venues/v-cache/seats')
        .expect(200);
      const second = await request(app.getHttpServer())
        .get('/api/catalog/venues/v-cache/seats')
        .expect(200);

      expect(first.headers['x-cache']).toBe('MISS');
      expect(second.headers['x-cache']).toBe('HIT');
      expect(second.body).toEqual(first.body);
      expect(upstreamCalls('/venues/v-cache/seats')).toHaveLength(1);
    });

    it('запрос с токеном в кеш не попадает и не читается из него', async () => {
      const authed = () =>
        request(app.getHttpServer())
          .get('/api/catalog/venues/v-auth/seats')
          .set('Authorization', `Bearer ${signToken('u1')}`)
          .expect(200);

      const first = await authed();
      await authed();

      expect(first.headers['x-cache']).toBeUndefined();
      expect(upstreamCalls('/venues/v-auth/seats')).toHaveLength(2);
    });

    it('параллельные запросы одного адреса объединяются в один запрос к сервису', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer()).get('/api/catalog/events/coalesce-1').expect(200),
        ),
      );

      expect(upstreamCalls('coalesce-1')).toHaveLength(1);
      const sources = responses.map((r) => r.headers['x-cache']).sort();
      expect(sources).toEqual(['COALESCED', 'COALESCED', 'COALESCED', 'COALESCED', 'MISS']);
    });

    it('404 не кешируется: появившееся событие видно сразу', async () => {
      const first = await request(app.getHttpServer())
        .get('/api/catalog/events/missing-1')
        .expect(404);
      await request(app.getHttpServer()).get('/api/catalog/events/missing-1').expect(404);

      expect(first.body).toMatchObject({ message: 'Событие не найдено' });
      expect(upstreamCalls('/events/missing-1')).toHaveLength(2);
    });

    it('query-строка не размножает записи кеша', async () => {
      await request(app.getHttpServer()).get('/api/catalog/venues/v-q/seats?a=1').expect(200);
      const second = await request(app.getHttpServer())
        .get('/api/catalog/venues/v-q/seats?a=2')
        .expect(200);

      expect(second.headers['x-cache']).toBe('HIT');
      expect(upstreamCalls('/venues/v-q/seats')).toHaveLength(1);
    });
  });

  describe('GET /api/events/:id/seat-status (агрегация)', () => {
    it('без токена: занятые и проданные места одним ответом, свой холд не запрашивается', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/events/ss-anon/seat-status')
        .expect(200);

      expect(res.body).toEqual({
        held: [{ seatId: 'A-1' }],
        sold: [{ seatId: 'B-2' }],
        myHold: null,
      });
      expect(upstreamCalls('/my-hold')).toHaveLength(0);
    });

    it('с токеном: добавляется свой холд, токен уходит в booking', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/events/ss-user/seat-status')
        .set('Authorization', 'Bearer user-token')
        .expect(200);

      expect(res.body.myHold).toEqual({ seatId: 'A-1', expiresAt: '2026-12-01T12:00:00.000Z' });
      expect(upstreamCalls('/my-hold')[0].headers.authorization).toBe('Bearer user-token');
    });

    it('холда нет (пустой ответ booking) — myHold: null', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/events/ss-nohold/seat-status')
        .set('Authorization', 'Bearer nohold')
        .expect(200);

      expect(res.body.myHold).toBeNull();
    });

    it('просроченный токен — 401 как есть, чтобы клиент обновил токен и повторил', async () => {
      await request(app.getHttpServer())
        .get('/api/events/ss-expired/seat-status')
        .set('Authorization', 'Bearer expired')
        .expect(401);
    });

    it('публичная часть кешируется на секунду, а собственный холд нет', async () => {
      const get = () =>
        request(app.getHttpServer())
          .get('/api/events/ss-cache/seat-status')
          .set('Authorization', 'Bearer user-token')
          .expect(200);
      await get();
      await get();
      await get();

      expect(upstreamCalls('/ss-cache/holds')).toHaveLength(1);
      expect(upstreamCalls('/ss-cache/sold-seats')).toHaveLength(1);
      expect(upstreamCalls('/ss-cache/my-hold')).toHaveLength(3);
    });

    it('fresh=1 с токеном обходит кеш публичной части, без токена не обходит', async () => {
      const call = (query: string, token?: string) => {
        const req = request(app.getHttpServer()).get(`/api/events/ss-fresh/seat-status${query}`);
        return (token ? req.set('Authorization', `Bearer ${token}`) : req).expect(200);
      };
      await call('', 'user-token');
      await call('?fresh=1');
      expect(upstreamCalls('/ss-fresh/holds')).toHaveLength(1);

      await call('?fresh=1', 'user-token');
      expect(upstreamCalls('/ss-fresh/holds')).toHaveLength(2);
      expect(upstreamCalls('/ss-fresh/sold-seats')).toHaveLength(2);
    });

    it('некорректный идентификатор события — 400, сервисы не тронуты', async () => {
      await request(app.getHttpServer()).get('/api/events/a%20b%3Fx/seat-status').expect(400);
      expect(upstreamRequests).toHaveLength(0);
    });
  });
});
