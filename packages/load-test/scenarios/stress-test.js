import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { createPublishedEvent, GATEWAY_URL, signUserToken } from '../lib/fixtures.js';

// Тест на поиск предела, а не на конкретный кейс (в отличие от
// single-seat-race.js и mixed-load.js). Ключевое отличие —
// executor: 'ramping-arrival-rate' вместо 'ramping-vus':
//
//   ramping-vus (как в mixed-load.js) — ЗАКРЫТАЯ модель: фиксированное
//   число VU, каждый ждёт свой ответ и только потом шлёт следующий запрос.
//   Если сервер начинает тормозить, VU сами замедляются вместе с ним —
//   реальный предел системы маскируется, тест как бы "подстраивается"
//   под деградацию вместо того, чтобы её показать.
//
//   ramping-arrival-rate — ОТКРЫТАЯ модель: k6 обязуется запускать
//   заданное число итераций в секунду НЕЗАВИСИМО от того, как быстро
//   отвечает сервер, поднимая для этого столько VU, сколько нужно (до
//   maxVUs). Когда система перестаёт справляться, это явно видно как
//   рост latency/ошибок и как dropped_iterations (не хватило VU, чтобы
//   удержать целевой темп) — то есть именно то, что нужно, чтобы найти
//   потолок, а не как он выглядит изнутри.
//
// Нагрузка — полный путь покупки (холд → заказ → фейковый вебхук), то
// есть это стресс не одного эндпоинта, а всей цепочки: gateway → booking
// (Redis) → payment (Postgres + запись в outbox) → RabbitMQ →
// notification (PDF + MinIO + SMTP) асинхронно следом. Пул мест
// намеренно небольшой относительно ожидаемого числа попыток — под
// целевым темпом места быстро раскупаются, и большая часть пикового
// окна нагружает систему уже "на распроданном" событии: это тоже
// реалистичный и тяжёлый профиль (все продолжают ломиться в момент
// старта продаж, когда мест почти не осталось).
//
// Запуск:
//   docker run --rm -v "$(pwd):/scripts" -w /scripts \
//     -e GATEWAY_URL=http://host.docker.internal:3000 \
//     grafana/k6 run scenarios/stress-test.js
//
// С метриками в Grafana:
//   docker run --rm -v "$(pwd):/scripts" -w /scripts \
//     -e GATEWAY_URL=http://host.docker.internal:3000 \
//     grafana/k6 run --out experimental-prometheus-rw=http://host.docker.internal:9090/api/v1/write \
//     scenarios/stress-test.js
//
// Найденный потолок железа/системы зависит от конкретной машины — здесь
// дефолты рассчитаны как "заведомо тяжело для голого dev-стека на одном
// ноутбуке", а не как проверенный вами предел. Если тест проходит чисто
// (см. README про пороги ниже) — поднимайте PEAK_RATE и гоняйте снова,
// пока не увидите деградацию: сам потолок и есть искомый результат.

const EVENTS_COUNT = Number(__ENV.EVENTS || 5);
const SEATS_PER_EVENT = Number(__ENV.SEATS_PER_EVENT || 40); // rows(5) x seatsPerRow(8)
const PEAK_RATE = Number(__ENV.PEAK_RATE || 100); // итераций/сек на пике (1-3 HTTP-запроса каждая)
const PRE_ALLOCATED_VUS = Number(__ENV.PRE_ALLOCATED_VUS || 200);
const MAX_VUS = Number(__ENV.MAX_VUS || 2000);

// 403/409 — штатные исходы конкуренции за место (см. orders.service.ts) и
// исчерпанного пула мест, не сбои для http_req_failed.
http.setResponseCallback(http.expectedStatuses(200, 201, 403, 409));

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: PRE_ALLOCATED_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { target: Math.round(PEAK_RATE * 0.25), duration: '20s' },
        { target: Math.round(PEAK_RATE * 0.5), duration: '20s' },
        { target: Math.round(PEAK_RATE * 0.75), duration: '20s' },
        { target: PEAK_RATE, duration: '30s' },
        { target: PEAK_RATE, duration: '60s' }, // удержание пика — тут обычно и видно деградацию
        { target: 0, duration: '20s' },
      ],
    },
  },
  thresholds: {
    // Специально мягкий и информационный, не жёсткий гейт: это тест на
    // поиск предела, а не проверка "прошёл/не прошёл". Порог здесь лишь
    // чтобы итоговый отчёт явно подсветил, если реальных 5xx/сетевых
    // сбоев стало заметно много.
    http_req_failed: ['rate<0.10'],
  },
};

const stageOutcomes = new Counter('stress_stage_outcomes');

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
  const seatId = pickRandom(event.seatIds);
  const token = signUserToken('stress');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const holdRes = http.post(
    `${GATEWAY_URL}/api/booking/events/${event.eventId}/holds`,
    JSON.stringify({ seatId }),
    { headers },
  );
  const holdOk = check(holdRes, {
    'холд: ожидаемый статус (201/409), не 5xx/обрыв': (r) => r.status === 201 || r.status === 409,
  });
  if (!holdOk) {
    stageOutcomes.add(1, {
      stage: 'hold',
      result: holdRes.status === 0 ? 'network_error' : String(holdRes.status),
    });
  }
  if (holdRes.status !== 201) {
    stageOutcomes.add(1, { stage: 'hold', result: 'conflict_or_error' });
    return;
  }
  stageOutcomes.add(1, { stage: 'hold', result: 'ok' });

  const orderRes = http.post(
    `${GATEWAY_URL}/api/payment/orders`,
    JSON.stringify({ eventId: event.eventId, seatId }),
    { headers },
  );
  const orderOk = check(orderRes, {
    'заказ: ожидаемый статус (201/403/409), не 5xx/обрыв': (r) =>
      r.status === 201 || r.status === 403 || r.status === 409,
  });
  if (!orderOk) {
    stageOutcomes.add(1, {
      stage: 'order',
      result: orderRes.status === 0 ? 'network_error' : String(orderRes.status),
    });
  }
  if (orderRes.status !== 201) {
    stageOutcomes.add(1, { stage: 'order', result: 'conflict_or_error' });
    return;
  }
  stageOutcomes.add(1, { stage: 'order', result: 'ok' });

  const order = orderRes.json();
  const webhookRes = http.post(
    `${GATEWAY_URL}/api/payment/dev/fake-webhook`,
    JSON.stringify({ providerIntentId: order.providerIntentId, type: 'payment.succeeded' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const webhookOk = check(webhookRes, {
    'вебхук принят (200), не 5xx/обрыв': (r) => r.status === 200,
  });
  stageOutcomes.add(1, {
    stage: 'webhook',
    result: webhookOk
      ? 'ok'
      : webhookRes.status === 0
        ? 'network_error'
        : String(webhookRes.status),
  });
}
