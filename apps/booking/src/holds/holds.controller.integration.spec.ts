import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../app.module';
import { REDIS_CLIENT } from '../redis/redis.module';

// В отличие от holds.service.spec.ts (моки) и holds.lua.integration.spec.ts
// (реальный Redis, но напрямую через HoldsService, в обход HTTP), этот
// файл поднимает настоящее Nest-приложение и бьёт через supertest —
// единственный способ проверить автотестом то, что юнит-тесты в принципе
// не видят: JwtAuthGuard реально отклоняет запрос без токена, а
// ValidationPipe реально режет невалидный seatId, а не просто "мок вернул
// то, что мы ему сказали".
//
// db 14 в REDIS_URL — своя логическая база, отдельная от db 15
// у holds.lua.integration.spec.ts: Jest гоняет файлы параллельными
// воркерами, и общая база с чужим flushdb() в beforeEach ловит гонку —
// ровно так один раз уже упал таймингованный тест на истечение холда.
// Изоляция без правки прод-кода: RedisModule просто подключается по
// этому URL, какой бы путь (базу) он ни указывал.
const baseRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
process.env.REDIS_URL = `${baseRedisUrl}/14`;
process.env.JWT_ACCESS_SECRET ??= 'test-secret-for-booking-integration';

function signToken(sub: string): string {
  return jwt.sign(
    { sub, email: `${sub}@seatlock.fun`, role: 'USER' },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: '15m' },
  );
}

describe('HoldsController (интеграция, настоящий Nest + настоящий Redis)', () => {
  jest.setTimeout(20_000);

  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // Ровно то же, что и настоящий main.ts — иначе тест проверяет не то
    // приложение, что реально едет в прод.
    app.setGlobalPrefix('api/booking', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    redis = app.get<Redis>(REDIS_CLIENT);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    await app.close();
  });

  const eventId = 'event-1';
  const seatId = '11111111-1111-4111-8111-111111111111';

  it('POST без токена — 401', async () => {
    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .send({ seatId })
      .expect(401);
  });

  it('POST с seatId не-UUID — 400 (ValidationPipe реально валидирует, не мок)', async () => {
    const token = signToken('user-1');

    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ seatId: 'not-a-uuid' })
      .expect(400);
  });

  it('POST с лишним незнакомым полем — 400 (forbidNonWhitelisted)', async () => {
    const token = signToken('user-1');

    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ seatId, extraField: 'нет такого поля в DTO' })
      .expect(400);
  });

  it('успешный hold — 201, и место реально видно занятым через GET /holds', async () => {
    const token = signToken('user-1');

    const res = await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ seatId })
      .expect(201);

    expect(res.body).toMatchObject({ seatId });
    expect(res.body.expiresAt).toEqual(expect.any(String));

    const held = await request(app.getHttpServer())
      .get(`/api/booking/events/${eventId}/holds`)
      .expect(200);
    expect(held.body).toEqual([{ seatId }]);
  });

  it('POST на уже занятое другим юзером место — 409', async () => {
    const tokenA = signToken('user-a');
    const tokenB = signToken('user-b');

    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ seatId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ seatId })
      .expect(409);
  });

  it('GET /holds — публично, без токена', async () => {
    await request(app.getHttpServer()).get(`/api/booking/events/${eventId}/holds`).expect(200, []);
  });

  it('GET /my-hold без токена — 401 (в отличие от /holds, этот эндпоинт приватный)', async () => {
    await request(app.getHttpServer()).get(`/api/booking/events/${eventId}/my-hold`).expect(401);
  });

  it('DELETE без активного холда — 204, no-op', async () => {
    const token = signToken('user-1');

    await request(app.getHttpServer())
      .delete(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('полный цикл: занял → my-hold видит своё место → отпустил → my-hold снова пуст', async () => {
    const token = signToken('user-1');

    await request(app.getHttpServer())
      .post(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .send({ seatId })
      .expect(201);

    const mine = await request(app.getHttpServer())
      .get(`/api/booking/events/${eventId}/my-hold`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mine.body).toMatchObject({ seatId });

    await request(app.getHttpServer())
      .delete(`/api/booking/events/${eventId}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // Пустое тело 200, не 204 — тот самый прод-баг, который чинили сегодня
    // на фронте (см. apps/web/src/lib/api-client.ts). Здесь фиксируем
    // контракт с другой стороны: сервер и должен отдавать именно так.
    const res = await request(app.getHttpServer())
      .get(`/api/booking/events/${eventId}/my-hold`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.text).toBe('');
  });
});
