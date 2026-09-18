import http from 'k6/http';
import { check } from 'k6';
import { signAccessToken } from './jwt.js';

export const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:3000';
export const JWT_ACCESS_SECRET = __ENV.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Тот же приём, что и signFixtureOrganizerToken в
// packages/e2e/tests/helpers/api-setup.ts: venue/event в catalog не ссылаются
// на настоящую запись auth.users (organizerId — просто id из JWT, без FK),
// поэтому фиктивный организатор ничем не отличается от настоящего.
export function signOrganizerToken() {
  const sub = `k6-organizer-${uniqueSuffix()}`;
  return signAccessToken(JWT_ACCESS_SECRET, {
    sub,
    email: `${sub}@seatlock.fun`,
    role: 'ORGANIZER',
  });
}

export function signUserToken(prefix = 'buyer') {
  const sub = `k6-${prefix}-${uniqueSuffix()}`;
  return signAccessToken(JWT_ACCESS_SECRET, { sub, email: `${sub}@seatlock.fun`, role: 'USER' });
}

/**
 * Заводит зал на `rows*seatsPerRow` мест и опубликованное событие —
 * напрямую через API, без UI. Порт createPublishedEventWithSeat() из
 * packages/e2e/tests/helpers/api-setup.ts на k6/http, с произвольным
 * размером зала (single-seat-race просит зал на одно место, mixed-load —
 * зал побольше).
 */
export function createPublishedEvent(rows, seatsPerRow) {
  const authHeaders = {
    Authorization: `Bearer ${signOrganizerToken()}`,
    'Content-Type': 'application/json',
  };
  const suffix = uniqueSuffix();

  const venueRes = http.post(
    `${GATEWAY_URL}/api/catalog/venues`,
    JSON.stringify({ name: `Зал ${suffix}`, city: 'Минск', address: 'пр. Победителей, 1' }),
    { headers: authHeaders },
  );
  check(venueRes, { 'venue создан': (r) => r.status === 201 });
  const venue = venueRes.json();

  const generateRes = http.post(
    `${GATEWAY_URL}/api/catalog/venues/${venue.id}/seats/generate`,
    JSON.stringify({ rows, seatsPerRow }),
    { headers: authHeaders },
  );
  check(generateRes, { 'места сгенерированы': (r) => r.status === 201 });

  const seatsRes = http.get(`${GATEWAY_URL}/api/catalog/venues/${venue.id}/seats`);
  const seats = seatsRes.json();

  const eventRes = http.post(
    `${GATEWAY_URL}/api/catalog/events`,
    JSON.stringify({
      venueId: venue.id,
      title: `Событие ${suffix}`,
      startsAt: '2026-12-20T19:00:00.000Z',
      basePriceCents: 100000,
    }),
    { headers: authHeaders },
  );
  check(eventRes, { 'событие создано': (r) => r.status === 201 });
  const event = eventRes.json();

  const publishRes = http.patch(`${GATEWAY_URL}/api/catalog/events/${event.id}/publish`, null, {
    headers: authHeaders,
  });
  check(publishRes, { 'событие опубликовано': (r) => r.status === 200 });

  return { eventId: event.id, seatIds: seats.map((s) => s.id) };
}
