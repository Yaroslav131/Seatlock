import type { BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as jwt from 'jsonwebtoken';
import { uniqueEmail } from './api-setup';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ??
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=auth';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me';

/**
 * Заводит покупателя и сразу авторизованную сессию в браузере (cookie
 * с refresh-токеном) — в обход /api/auth/register. Тот же мотив, что и
 * у signFixtureOrganizerToken в api-setup.ts (там — обход ради прямых
 * вызовов API), но здесь нужна полноценная браузерная сессия, а не
 * только заголовок Authorization: register/login под общим
 * ThrottlerGuard (5 запросов/60с на IP), и при параллельном прогоне
 * нескольких спецификаций, каждая из которых реально регистрируется
 * через форму, лимит реально исчерпывается — так однажды и сломалось
 * (seat-booking-two-users.spec.ts поймал 429 из-за соседних тестов).
 *
 * Пишем пользователя и refresh-токен напрямую в Postgres (как реальный
 * /register сделал бы через AuthService.issueTokenPair), затем кладём
 * тот же по форме refresh-токен в cookie — App на маунте сам обменяет
 * её на access-токен через /api/auth/refresh, ни разу не задев
 * throttled register/login.
 */
export async function signInAsFixtureBuyer(context: BrowserContext): Promise<{ email: string }> {
  const email = uniqueEmail('buyer');
  const client = new Client({ connectionString: AUTH_DATABASE_URL });
  await client.connect();
  try {
    const userId = randomUUID();
    // passwordHash никогда не проверяется (логин не вызывается) —
    // значение не важно, лишь бы NOT NULL-колонка была заполнена.
    await client.query(
      'INSERT INTO auth.users (id, email, "passwordHash", role, "updatedAt") VALUES ($1, $2, $3, $4, now())',
      [userId, email, 'unused', 'USER'],
    );

    const refreshRowId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      'INSERT INTO auth.refresh_tokens (id, "userId", "expiresAt") VALUES ($1, $2, $3)',
      [refreshRowId, userId, expiresAt],
    );

    const refreshToken = jwt.sign({ sub: userId, jti: refreshRowId }, JWT_REFRESH_SECRET, {
      expiresIn: '30d',
    });
    await context.addCookies([
      {
        name: 'refreshToken',
        value: refreshToken,
        domain: 'localhost',
        path: '/api/auth',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    return { email };
  } finally {
    await client.end();
  }
}
