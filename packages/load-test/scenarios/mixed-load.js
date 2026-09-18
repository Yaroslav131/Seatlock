import http from 'k6/http';
import { check, sleep } from 'k6';
import { createPublishedEvent, GATEWAY_URL, signUserToken } from '../lib/fixtures.js';

// Реалистичная нагрузка на весь путь покупки: рампинг VU, каждый идёт по
// своему событию/месту (не все в одну точку, как single-seat-race.js) —
// проверяет общую устойчивость системы под конкурентной нагрузкой, а не
// только гоночный кейс. Полный путь: список событий → карта занятых мест →
// холд свободного места → заказ → фейковый вебхук оплаты (тот же порядок
// вызовов, что и apps/web/src/pages/CheckoutPage.tsx на реальном фронте).
//
// Запуск:
//   docker run --rm -i --network host grafana/k6 run - < scenarios/mixed-load.js
//   docker run --rm -i --network host grafana/k6 run \
//     --out experimental-prometheus-rw=http://localhost:9090/api/v1/write \
//     - < scenarios/mixed-load.js

const EVENTS_COUNT = Number(__ENV.EVENTS || 5);
const SEATS_PER_EVENT = Number(__ENV.SEATS_PER_EVENT || 30); // rows(5) x seatsPerRow(6)

// См. тот же комментарий в single-seat-race.js: 403/409 здесь — штатные
// исходы гонки за место, не сбои для http_req_failed.
http.setResponseCallback(http.expectedStatuses(200, 201, 403, 409));

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: Number(__ENV.PEAK_VUS || 30) },
        { duration: '40s', target: Number(__ENV.PEAK_VUS || 30) },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // 403/409 — ожидаемые исходы гонки за место (см. orders.service.ts),
    // это не сбои. Порог ловит реальные 5xx и сетевые сбои (в т.ч.
    // единичные i/o timeout на стыке k6-контейнера и bare-host сервисов
    // через host.docker.internal при рампдауне — сама Windows/Docker
    // Desktop сеть иногда даёт единичный таймаут под резким снятием
    // нагрузки, не сервис). 5% — запас под этот шум без потери
    // чувствительности к настоящей деградации.
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  const events = [];
  for (let i = 0; i < EVENTS_COUNT; i++) {
    events.push(createPublishedEvent(5, SEATS_PER_EVENT / 5));
  }
  return { events };
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function (data) {
  const event = pickRandom(data.events);
  const token = signUserToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Карта зала: как и настоящий SeatMap-компонент, сверяемся со списком уже
  // занятых мест перед выбором — но при десятках параллельных VU список
  // всё равно может устареть за миллисекунды до запроса холда, это часть
  // проверяемой нагрузки, не баг сценария.
  const heldRes = http.get(`${GATEWAY_URL}/api/booking/events/${event.eventId}/holds`);
  check(heldRes, { 'список холдов получен': (r) => r.status === 200 });
  // При сетевом сбое (таймаут/обрыв) тело ответа — null, не JSON с
  // ошибочным статусом: .json() на нём бросает необработанное
  // исключение и прерывает итерацию раньше, чем успевает сработать check.
  if (heldRes.status !== 200) {
    sleep(1);
    return;
  }
  const heldSeatIds = new Set((heldRes.json() || []).map((h) => h.seatId));
  const freeSeats = event.seatIds.filter((id) => !heldSeatIds.has(id));
  if (freeSeats.length === 0) {
    sleep(1);
    return;
  }
  const seatId = pickRandom(freeSeats);

  const holdRes = http.post(
    `${GATEWAY_URL}/api/booking/events/${event.eventId}/holds`,
    JSON.stringify({ seatId }),
    { headers },
  );
  check(holdRes, { 'холд: 201 или 409, не 5xx': (r) => r.status === 201 || r.status === 409 });
  if (holdRes.status !== 201) {
    sleep(1);
    return;
  }

  const orderRes = http.post(
    `${GATEWAY_URL}/api/payment/orders`,
    JSON.stringify({ eventId: event.eventId, seatId }),
    { headers },
  );
  check(orderRes, { 'заказ: 201 или 409, не 5xx': (r) => r.status === 201 || r.status === 409 });
  if (orderRes.status !== 201) {
    sleep(1);
    return;
  }

  const order = orderRes.json();
  const webhookRes = http.post(
    `${GATEWAY_URL}/api/payment/dev/fake-webhook`,
    JSON.stringify({ providerIntentId: order.providerIntentId, type: 'payment.succeeded' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(webhookRes, { 'фейковый вебхук принят': (r) => r.status === 200 || r.status === 201 });

  sleep(1);
}
