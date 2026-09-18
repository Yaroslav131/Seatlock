# Нагрузочные тесты (k6)

Проверяют под конкурентной нагрузкой ключевой инвариант проекта: место
нельзя продать дважды (README, раздел про ADR 0003). Не turbo-пакет и не
TypeScript — k6 использует свой собственный JS-рантайм (Goja), а не
Node.js, поэтому обычные npm-зависимости (`jsonwebtoken`, `pg` и т.д.)
здесь недоступны. Все токены подписываются вручную через `k6/crypto` (см.
`lib/jwt.js`) — тем же способом, каким сервисы их проверяют: `jwt.verify()`
по общему `JWT_ACCESS_SECRET`, без похода в auth (см.
`apps/*/src/auth/jwt-auth.guard.ts`).

## Запуск

Нужен только Docker — локально устанавливать k6 не обязательно. Гоняем
против **локального dev-стека** (`pnpm infra:up` + `pnpm dev`), не против
прода — см. план в `docker-compose.yml`/README о поэтапном раскатывании.

```bash
docker run --rm -i --network host grafana/k6 run - < scenarios/single-seat-race.js
docker run --rm -i --network host grafana/k6 run - < scenarios/mixed-load.js
```

`--network host` — сервисы слушают `localhost:300x` на хосте (см.
`docker/prometheus.yml` про тот же нюанс с bare-host процессами в dev).
На Windows/macOS с Docker Desktop вместо `--network host` используйте
`-e GATEWAY_URL=http://host.docker.internal:3000`.

### С метриками прогона в Grafana

Тот же Prometheus, что скрейпит `/metrics` сервисов, принимает и
remote-write от k6 (`--web.enable-remote-write-receiver` уже включён в
`docker-compose.yml`) — результаты нагрузочного теста видно на том же
дашборде (`seatlock-overview`), что и метрики самих сервисов:

```bash
docker run --rm -i --network host grafana/k6 run \
  --out experimental-prometheus-rw=http://localhost:9090/api/v1/write \
  - < scenarios/single-seat-race.js
```

## Сценарии

- **`single-seat-race.js`** — главный сценарий: `VUS` (по умолчанию 50)
  виртуальных пользователей одновременно бьют в _одно и то же_ место
  одного события. Ожидаемый результат: ровно один `201` на холд, у всех
  остальных `409`, ни одного `5xx`; победитель холда дополнительно
  проверяет вторую линию обороны — создание заказа в `payment`
  (partial unique index в Postgres). Настраивается через `VUS=200`.
- **`mixed-load.js`** — реалистичная нагрузка: рампинг до `PEAK_VUS`
  (по умолчанию 30) виртуальных пользователей проходят весь путь покупки
  (список событий → карта мест → холд → заказ → фейковый вебхук оплаты)
  на `EVENTS` разных событиях (по умолчанию 5) по `SEATS_PER_EVENT` мест
  каждое — проверяет общую устойчивость системы, а не только гоночный
  кейс.

Оба сценария сами создают себе фикстуры (зал, событие, места) в
`setup()` — ничего готовить заранее не нужно, кроме поднятого dev-стека.

## Переменные окружения

| Переменная          | По умолчанию                  | Смысл                                         |
| ------------------- | ----------------------------- | --------------------------------------------- |
| `GATEWAY_URL`       | `http://localhost:3000`       | Адрес gateway                                 |
| `JWT_ACCESS_SECRET` | `dev-access-secret-change-me` | Должен совпадать с `.env` сервисов            |
| `VUS`               | `50`                          | `single-seat-race.js`: число участников гонки |
| `EVENTS`            | `5`                           | `mixed-load.js`: число событий                |
| `SEATS_PER_EVENT`   | `30`                          | `mixed-load.js`: мест на событие              |
| `PEAK_VUS`          | `30`                          | `mixed-load.js`: пиковое число VU             |

## Не часть CI

Оба сценария — ручной/периодический прогон, не проверка на каждый PR
(слишком долго и шумно). В CI вместо этого — по одному тесту `GET /metrics`
на сервис (см. `*.integration.spec.ts`), что метрики вообще отдаются.
