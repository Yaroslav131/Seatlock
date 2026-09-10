import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './app.module';

// gateway настраивает bodyParser/прокси/префикс вручную в main.ts, а не
// декларативно через Nest-модуль (см. комментарии там) — этот тест
// повторяет ровно тот же порядок (bodyParser: false → прокси → json/
// urlencoded → setGlobalPrefix), иначе он проверяет не то приложение,
// что реально едет в прод. Апстримы auth/catalog/booking подменены на
// один локальный фейковый HTTP-сервер: юнит-тестов у gateway вообще
// нет, и это единственный способ поймать автотестом баг с bodyParser/
// pathFilter (пустое тело улетало на upstream), который сегодня уже
// дважды ловили руками в браузере.
process.env.DATABASE_URL ??= 'postgresql://seatlock:seatlock@localhost:5433/seatlock';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-gateway-integration';

function signToken(sub: string): string {
  return jwt.sign(
    { sub, email: `${sub}@seatlock.fun`, role: 'USER' },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: '15m' },
  );
}

describe('gateway (интеграция: прокси + /api/me)', () => {
  jest.setTimeout(20_000);

  let app: INestApplication;
  let upstream: http.Server;
  let upstreamRequests: Array<{ method: string; url: string; body: string }>;

  beforeAll(async () => {
    upstreamRequests = [];
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk;
      });
      req.on('end', () => {
        upstreamRequests.push({ method: req.method!, url: req.url!, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upstream: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, resolve));
    const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
    process.env.AUTH_SERVICE_URL = upstreamUrl;
    process.env.CATALOG_SERVICE_URL = upstreamUrl;
    process.env.BOOKING_SERVICE_URL = upstreamUrl;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    const config = app.get(ConfigService);

    app.use(
      createProxyMiddleware({
        target: config.getOrThrow<string>('AUTH_SERVICE_URL'),
        changeOrigin: true,
        pathFilter: '/api/auth',
      }),
    );
    app.use(
      createProxyMiddleware({
        target: config.getOrThrow<string>('CATALOG_SERVICE_URL'),
        changeOrigin: true,
        pathFilter: '/api/catalog',
      }),
    );
    app.use(
      createProxyMiddleware({
        target: config.getOrThrow<string>('BOOKING_SERVICE_URL'),
        changeOrigin: true,
        pathFilter: '/api/booking',
      }),
    );
    app.use(json());
    app.use(urlencoded({ extended: true }));
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

    await app.init();
  });

  beforeEach(() => {
    upstreamRequests.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('POST /api/auth/... с непустым телом долетает до апстрима нетронутым (регресс на bodyParser/pathFilter)', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'secret' })
      .expect(200);

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].method).toBe('POST');
    expect(upstreamRequests[0].url).toBe('/api/auth/login');
    expect(JSON.parse(upstreamRequests[0].body)).toEqual({ email: 'a@b.com', password: 'secret' });
  });

  it('GET /api/catalog/... проксируется на свой апстрим с тем же путём', async () => {
    await request(app.getHttpServer()).get('/api/catalog/events').expect(200);

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({ method: 'GET', url: '/api/catalog/events' });
  });

  it('GET /api/me с валидным JWT отвечает сам, не ходит в апстрим', async () => {
    const token = signToken('user-1');

    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toMatchObject({ sub: 'user-1', email: 'user-1@seatlock.fun', role: 'USER' });
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
});
