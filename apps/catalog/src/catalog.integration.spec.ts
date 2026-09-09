import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AppModule } from './app.module';
import { REDIS_CLIENT } from './cache/redis.module';
import { PrismaService } from './prisma/prisma.service';

// В отличие от venues.service.spec.ts/events.service.spec.ts (моки
// PrismaService/Redis), этот файл поднимает настоящее Nest-приложение
// поверх настоящих Postgres и Redis и бьёт через supertest — юнит-тесты
// на моках в принципе не видят RolesGuard на реальном запросе, и мок
// redis.del никогда не поймает баг в самой инвалидации (если бы ключ
// был неверно собран, мок всё равно бы «удалился успешно»).
//
// CATALOG_DATABASE_URL/REDIS_URL — тот же локальный docker-compose, что
// и у остального проекта; в CI workflow подставляет свои (см.
// .github/workflows/ci.yml). JWT_ACCESS_SECRET — свой, тестовый: токены
// этого файла подписываются и проверяются только внутри него самого.
process.env.CATALOG_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=catalog';
process.env.REDIS_URL ??= 'redis://localhost:6380';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-catalog-integration';

function signToken(sub: string, role: 'USER' | 'ORGANIZER' | 'ADMIN'): string {
  return jwt.sign({ sub, email: `${sub}@seatlock.fun`, role }, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: '15m',
  });
}

const PUBLISHED_LIST_CACHE_KEY = 'catalog:events:published';
const eventCacheKey = (id: string): string => `catalog:events:${id}`;

describe('CatalogController (интеграция, настоящий Nest + настоящий Postgres + Redis)', () => {
  jest.setTimeout(20_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Ровно то же, что и настоящий main.ts — иначе тест проверяет не то
    // приложение, что реально едет в прод.
    app.set('trust proxy', true);
    app.setGlobalPrefix('api/catalog', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS_CLIENT);
  });

  beforeEach(async () => {
    await redis.flushdb();
    // events зависят от venues через FK — сначала дети.
    await prisma.event.deleteMany();
    await prisma.seat.deleteMany();
    await prisma.venue.deleteMany();
  });

  afterAll(async () => {
    await prisma.event.deleteMany();
    await prisma.seat.deleteMany();
    await prisma.venue.deleteMany();
    await redis.flushdb();
    await app.close();
    // RedisModule не реализует OnModuleDestroy (в отличие от
    // PrismaService) — app.close() гасит Nest-приложение, но TCP-
    // соединение с Redis остаётся открытым и без этого Jest висит
    // после «Tests: 5 passed», не завершаясь вообще.
    await redis.quit();
  });

  const createVenueDto = { name: 'Дворец спорта', city: 'Минск', address: 'пр. Победителей, 1' };

  it('POST /venues без роли ORGANIZER/ADMIN — 403 (RolesGuard на реальном запросе)', async () => {
    const token = signToken('user-1', 'USER');

    await request(app.getHttpServer())
      .post('/api/catalog/venues')
      .set('Authorization', `Bearer ${token}`)
      .send(createVenueDto)
      .expect(403);
  });

  it('POST /venues с невалидным телом — 400 (ValidationPipe реально валидирует, не мок)', async () => {
    const token = signToken('organizer-1', 'ORGANIZER');

    await request(app.getHttpServer())
      .post('/api/catalog/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A' }) // короче MinLength(2), да и city/address отсутствуют
      .expect(400);
  });

  it('POST /venues организатором — 201, зал реально создан в Postgres', async () => {
    const token = signToken('organizer-1', 'ORGANIZER');

    const res = await request(app.getHttpServer())
      .post('/api/catalog/venues')
      .set('Authorization', `Bearer ${token}`)
      .send(createVenueDto)
      .expect(201);

    expect(res.body).toMatchObject(createVenueDto);
    expect(await prisma.venue.count()).toBe(1);
  });

  it('публикация события инвалидирует Redis-кэш (список и карточку), а не просто отвечает 200', async () => {
    const organizerToken = signToken('organizer-1', 'ORGANIZER');

    const venueRes = await request(app.getHttpServer())
      .post('/api/catalog/venues')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send(createVenueDto)
      .expect(201);
    const venueId = venueRes.body.id as string;

    const eventRes = await request(app.getHttpServer())
      .post('/api/catalog/events')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({
        venueId,
        title: 'Концерт',
        startsAt: '2026-12-20T19:00:00.000Z',
        basePriceCents: 250000,
      })
      .expect(201);
    const eventId = eventRes.body.id as string;

    // Прогреваем оба кэш-ключа реальными GET-запросами — так же, как
    // это делает обычный трафик, а не подсовываем значения напрямую.
    await request(app.getHttpServer()).get(`/api/catalog/events/${eventId}`).expect(200);
    await request(app.getHttpServer()).get('/api/catalog/events').expect(200);

    expect(await redis.get(eventCacheKey(eventId))).not.toBeNull();
    expect(await redis.get(PUBLISHED_LIST_CACHE_KEY)).not.toBeNull();

    await request(app.getHttpServer())
      .patch(`/api/catalog/events/${eventId}/publish`)
      .set('Authorization', `Bearer ${organizerToken}`)
      .expect(200);

    expect(await redis.get(eventCacheKey(eventId))).toBeNull();
    expect(await redis.get(PUBLISHED_LIST_CACHE_KEY)).toBeNull();

    const publishedRes = await request(app.getHttpServer()).get('/api/catalog/events').expect(200);
    expect(publishedRes.body).toHaveLength(1);
    expect(publishedRes.body[0]).toMatchObject({ id: eventId, status: 'PUBLISHED' });
  });

  it('публикация чужого события организатором — 403 (не ADMIN и не свой организатор)', async () => {
    const ownerToken = signToken('organizer-owner', 'ORGANIZER');
    const otherToken = signToken('organizer-other', 'ORGANIZER');

    const venueRes = await request(app.getHttpServer())
      .post('/api/catalog/venues')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(createVenueDto)
      .expect(201);

    const eventRes = await request(app.getHttpServer())
      .post('/api/catalog/events')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        venueId: venueRes.body.id,
        title: 'Концерт',
        startsAt: '2026-12-20T19:00:00.000Z',
        basePriceCents: 250000,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/catalog/events/${eventRes.body.id}/publish`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
  });
});
