import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { createPublishedEvent, GATEWAY_URL, signUserToken } from '../lib/fixtures.js';

// Главный сценарий плана: N виртуальных пользователей одновременно бьют в
// ОДНО и то же место одного события. Это прямая нагрузочная проверка
// ключевого инварианта проекта (README: "не продать одно место дважды") —
// его первая и главная линия обороны — Redis SETNX в
// apps/booking/src/holds/holds.service.ts (hold_attempts_total{result}).
// Кто выиграл холд, тот же VU сразу проверяет и вторую линию (partial
// unique index в payment — orders_created_total{result}), доводя свою
// попытку до создания заказа.
//
// Запуск (без локальной установки k6):
//   docker run --rm -i --network host grafana/k6 run - < scenarios/single-seat-race.js
// С экспортом метрик прогона в тот же Prometheus, что и у сервисов
// (dev-стек включает --web.enable-remote-write-receiver именно ради этого):
//   docker run --rm -i --network host grafana/k6 run \
//     --out experimental-prometheus-rw=http://localhost:9090/api/v1/write \
//     - < scenarios/single-seat-race.js

const VUS = Number(__ENV.VUS || 50);

// По умолчанию k6 считает http_req_failed по HTTP-статусу (>=400 —
// "сбой"), а 409 здесь — ожидаемый, правильный исход гонки, не сбой.
// Явно говорим k6, какие статусы легитимны, иначе порог ниже (единственная
// содержательная проверка на реальные 5xx) всегда будет красным.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    race: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    // Единственный содержательный порог: ни одного 5xx ни на одном из
    // двух эндпоинтов — гонка обязана разрешаться штатными 201/409, а не
    // падением сервиса под конкурентной нагрузкой.
    http_req_failed: ['rate<0.01'],
  },
};

const holdOutcomes = new Counter('race_hold_outcomes');
const orderOutcomes = new Counter('race_order_outcomes');

export function setup() {
  const { eventId, seatIds } = createPublishedEvent(1, 1);
  return { eventId, seatId: seatIds[0] };
}

export default function (data) {
  const token = signUserToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const holdRes = http.post(
    `${GATEWAY_URL}/api/booking/events/${data.eventId}/holds`,
    JSON.stringify({ seatId: data.seatId }),
    { headers },
  );
  check(holdRes, {
    'холд: 201 или 409, не 5xx': (r) => r.status === 201 || r.status === 409,
  });
  holdOutcomes.add(1, { result: holdRes.status === 201 ? 'ok' : String(holdRes.status) });

  if (holdRes.status !== 201) {
    return;
  }

  // Только победитель гонки за холд имеет право дойти до создания
  // заказа (payment сверяет holder через booking/my-hold, см.
  // orders.service.ts) — остальные VU здесь не участвуют, вторая линия
  // обороны при таком сценарии проверяется на единственном "легальном"
  // после первого барьера запросе.
  const orderRes = http.post(
    `${GATEWAY_URL}/api/payment/orders`,
    JSON.stringify({ eventId: data.eventId, seatId: data.seatId }),
    { headers },
  );
  check(orderRes, {
    'заказ: 201, не 5xx': (r) => r.status === 201,
  });
  orderOutcomes.add(1, { result: orderRes.status === 201 ? 'ok' : String(orderRes.status) });
}

export function teardown(data) {
  console.log(
    `single-seat-race: eventId=${data.eventId} seatId=${data.seatId} — см. Grafana/Prometheus для итогов`,
  );
}
