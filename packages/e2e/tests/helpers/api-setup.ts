import { APIRequestContext } from '@playwright/test';
import * as jwt from 'jsonwebtoken';

const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? 'http://localhost:3000';
// Тот же секрет, которым реально подписывает токены auth (см. корневой
// .env.example) — locally он уже такой по умолчанию; в CI e2e-джоб
// должен явно выставить тот же JWT_ACCESS_SECRET, что и у самих сервисов.
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me';

export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@seatlock.fun`;
}

async function json<T>(res: {
  json(): Promise<unknown>;
  ok(): boolean;
  status(): number;
}): Promise<T> {
  if (!res.ok()) {
    throw new Error(`запрос к gateway завершился ${res.status()}`);
  }
  return (await res.json()) as T;
}

/**
 * Подписывает JWT организатора напрямую — без похода в /api/auth/register
 * или /login. Venue/Event в схеме catalog не ссылаются на настоящую
 * запись auth.users (см. schema.prisma: organizerId — просто id из JWT,
 * без FK), так что фиктивный организатор ничем не отличается от
 * настоящего для целей venue/event-фикстур. Это принципиально: у
 * /api/auth/register и /login стоит ThrottlerGuard (5 запросов/60с на
 * IP, см. Фазу 4) — если каждый e2e-тест регистрировал и логинил
 * организатора по-настоящему, параллельный прогон специфаций упирался
 * бы в этот лимит на ровном месте (и упирался — так это и нашли).
 * Реальные организаторы, которых стоит регистрировать по-настоящему,
 * остаются только там, где сама регистрация — предмет теста
 * (organizer-flow.spec.ts).
 */
function signFixtureOrganizerToken(): string {
  const sub = `e2e-fixture-organizer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return jwt.sign({ sub, email: `${sub}@seatlock.fun`, role: 'ORGANIZER' }, JWT_ACCESS_SECRET, {
    expiresIn: '1h',
  });
}

export interface PublishedEventFixture {
  eventId: string;
  seatId: string;
}

/**
 * Заводит зал с одним местом и опубликованное событие напрямую через
 * API. Полный клик-через-интерфейс путь создания события уже покрыт
 * organizer-flow.spec.ts; здесь это просто быстрая фикстура для
 * тестов, которые проверяют совсем другое поведение — бронирование
 * места, а не создание событий.
 */
export async function createPublishedEventWithSeat(
  request: APIRequestContext,
): Promise<PublishedEventFixture> {
  const authHeaders = { Authorization: `Bearer ${signFixtureOrganizerToken()}` };
  const suffix = uniqueEmail('venue');

  const venueRes = await request.post(`${GATEWAY_URL}/api/catalog/venues`, {
    headers: authHeaders,
    data: { name: `Зал ${suffix}`, city: 'Минск', address: 'пр. Победителей, 1' },
  });
  const venue = await json<{ id: string }>(venueRes);

  await request.post(`${GATEWAY_URL}/api/catalog/venues/${venue.id}/seats/generate`, {
    headers: authHeaders,
    data: { rows: 1, seatsPerRow: 1 },
  });
  const seatsRes = await request.get(`${GATEWAY_URL}/api/catalog/venues/${venue.id}/seats`);
  const seats = await json<Array<{ id: string }>>(seatsRes);

  const eventRes = await request.post(`${GATEWAY_URL}/api/catalog/events`, {
    headers: authHeaders,
    data: {
      venueId: venue.id,
      title: `Событие ${suffix}`,
      startsAt: '2026-12-20T19:00:00.000Z',
      basePriceCents: 100000,
    },
  });
  const event = await json<{ id: string }>(eventRes);

  await request.patch(`${GATEWAY_URL}/api/catalog/events/${event.id}/publish`, {
    headers: authHeaders,
  });

  return { eventId: event.id, seatId: seats[0].id };
}
