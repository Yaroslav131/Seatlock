import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';

// В отличие от auth.service.spec.ts (мок PrismaService), этот файл
// поднимает настоящее Nest-приложение поверх настоящего Postgres и
// бьёт через supertest — единственный способ проверить автотестом
// ThrottlerGuard на реальном HTTP-запросе и то, что ротация refresh-
// токена и массовый отзыв сессий действительно долетают до БД, а не
// просто до мока, который отвечает так, как мы сами ему сказали.
//
// AUTH_DATABASE_URL — тот же локальный docker-compose Postgres
// (db "seatlock", схема "auth"), что и у остального проекта; в CI
// workflow подставляет свой (см. .github/workflows/ci.yml). JWT-секреты
// не обязаны совпадать с .env — токены этого файла ни с чем, кроме
// самого себя, не сверяются.
process.env.AUTH_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=auth';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-for-auth-integration';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-for-auth-integration';

function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@seatlock.fun`;
}

function extractRefreshCookie(res: request.Response): string {
  const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const raw = cookies.find((c) => c.startsWith('refreshToken='));
  if (!raw) {
    throw new Error('в ответе нет cookie refreshToken');
  }
  return raw.split(';')[0].split('=')[1];
}

describe('AuthController (интеграция, настоящий Nest + настоящий Postgres)', () => {
  jest.setTimeout(20_000);

  let app: NestExpressApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Ровно то же, что и настоящий main.ts — иначе тест проверяет не то
    // приложение, что реально едет в прод.
    app.set('trust proxy', true);
    app.use(cookieParser());
    app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    await app.close();
  });

  it('регистрация — 201, создаёт пользователя, отдаёт access-токен и httpOnly refresh-cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: uniqueEmail(), password: 'supersecret123' })
      .expect(201);

    expect(res.body.accessToken).toEqual(expect.any(String));
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('refreshToken=') && c.includes('HttpOnly'))).toBe(true);

    expect(await prisma.user.count()).toBe(1);
  });

  it('регистрация на уже занятый email — 409', async () => {
    const dto = { email: uniqueEmail(), password: 'supersecret123' };
    await request(app.getHttpServer()).post('/api/auth/register').send(dto).expect(201);
    await request(app.getHttpServer()).post('/api/auth/register').send(dto).expect(409);
  });

  it('регистрация с телом без password — 400 (ValidationPipe реально валидирует, не мок)', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: uniqueEmail() })
      .expect(400);
  });

  it('полный цикл: регистрация → refresh → повторное использование ротированного токена гасит все сессии', async () => {
    const agent = request.agent(app.getHttpServer());

    const registerRes = await agent
      .post('/api/auth/register')
      .send({ email: uniqueEmail(), password: 'supersecret123' })
      .expect(201);
    const firstRefreshCookie = extractRefreshCookie(registerRes);

    // agent сам подставляет сохранённую cookie — как реальный браузер.
    const refreshRes = await agent.post('/api/auth/refresh').expect(200);
    expect(refreshRes.body.accessToken).toEqual(expect.any(String));
    const secondRefreshCookie = extractRefreshCookie(refreshRes);
    expect(secondRefreshCookie).not.toBe(firstRefreshCookie);

    // Повторно предъявляем СТАРЫЙ (уже заменённый при ротации) токен —
    // отдельным запросом без agent, чтобы явно подставить именно его.
    const reuseRes = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${firstRefreshCookie}`)
      .expect(401);
    expect(reuseRes.body.message).toContain('отозвана');

    // Массовый отзыв должен погасить и второй (актуальный на вид) токен.
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .set('Cookie', `refreshToken=${secondRefreshCookie}`)
      .expect(401);

    const revoked = await prisma.refreshToken.findMany();
    expect(revoked.length).toBeGreaterThanOrEqual(2);
    expect(revoked.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('POST /login: неверный пароль — 401, а после 5 попыток за 60с — лимит (ThrottlerGuard, 429)', async () => {
    const dto = { email: uniqueEmail(), password: 'wrong-password' };

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).post('/api/auth/login').send(dto).expect(401);
    }
    await request(app.getHttpServer()).post('/api/auth/login').send(dto).expect(429);
  });
});
