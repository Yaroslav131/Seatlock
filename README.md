# SeatLock

Продажа билетов на мероприятия с бронированием конкретных мест.
Учебный микросервисный проект: NestJS, PostgreSQL, Redis, RabbitMQ, React.

Ключевая задача проекта — **не продать одно место дважды** при сотнях одновременных
запросов. Всё остальное строится вокруг этого инварианта.

**Продакшн:** [seatlock.fun](https://seatlock.fun)

## Стек

| Слой             | Технологии                                               |
| ---------------- | -------------------------------------------------------- |
| Бэкенд           | NestJS 11, TypeScript, Prisma                            |
| Основная база    | PostgreSQL 17 (своя схема на каждый сервис)              |
| Кэш и холды мест | Redis 7                                                  |
| Очереди          | RabbitMQ 4                                               |
| Файлы            | S3 (MinIO — свой контейнер, в dev и в проде)             |
| Платежи          | fake-провайдер (Stripe недоступен из Беларуси — санкции) |
| Письма           | Resend (SMTP), в dev/CI — Mailpit                        |
| Фронтенд         | React 19, Vite, TypeScript, Zustand                      |
| Инфраструктура   | Docker, GitHub Actions (CI/CD), Caddy, свой сервер       |

## Быстрый старт

Нужны Node.js 22+, pnpm и Docker.

```bash
git clone https://github.com/Yaroslav131/Seatlock.git && cd Seatlock
cp .env.example .env
pnpm install
pnpm infra:up
pnpm dev
```

Проверить, что бэкенд поднялся:

```bash
curl http://localhost:3000/health/ready
```

Ответ содержит статус и латентность каждой зависимости:

```json
{
  "status": "ok",
  "service": "gateway",
  "uptimeSec": 12,
  "checks": {
    "postgres": { "status": "up", "latencyMs": 15 },
    "redis": { "status": "up", "latencyMs": 1 }
  }
}
```

Фронтенд — на http://localhost:5173 (dev-сервер Vite сам проксирует `/api` на gateway,
поэтому браузер видит всё как один origin даже локально).

## Порты

Порты намеренно сдвинуты от стандартных, чтобы не конфликтовать
с локально установленными базами.

| Сервис       | Порт        | Веб-интерфейс                                  |
| ------------ | ----------- | ---------------------------------------------- |
| web          | 5173        | http://localhost:5173                          |
| gateway      | 3000        | —                                              |
| auth         | 3001        | —                                              |
| catalog      | 3002        | —                                              |
| booking      | 3003        | —                                              |
| payment      | 3004        | —                                              |
| notification | 3005        | —                                              |
| PostgreSQL   | 5433        | —                                              |
| Redis        | 6380        | —                                              |
| RabbitMQ     | 5673        | http://localhost:15673 (seatlock / seatlock)   |
| MinIO        | 9100        | http://localhost:9101 (seatlock / seatlock123) |
| Mailpit      | 1026 (SMTP) | http://localhost:8026                          |

## Команды

| Команда            | Что делает                                 |
| ------------------ | ------------------------------------------ |
| `pnpm dev`         | Запускает все сервисы в режиме watch       |
| `pnpm build`       | Собирает все пакеты                        |
| `pnpm lint`        | ESLint по всему монорепозиторию            |
| `pnpm typecheck`   | Проверка типов без сборки                  |
| `pnpm test`        | Тесты во всех пакетах (юнит + интеграция)  |
| `pnpm test:e2e`    | Playwright — нужен уже поднятый `pnpm dev` |
| `pnpm format`      | Форматирование Prettier                    |
| `pnpm infra:up`    | Поднимает Docker-инфраструктуру            |
| `pnpm infra:down`  | Останавливает контейнеры                   |
| `pnpm infra:reset` | Останавливает и **удаляет данные**         |
| `pnpm infra:logs`  | Логи контейнеров                           |

## Тестирование

Пирамида в три слоя, конвенция едина для всех пакетов:

- **Юнит** (`*.spec.ts`) — чистая логика на моках, без сети и БД. Есть
  в `auth`/`catalog`/`booking`.
- **Интеграция** (`*.integration.spec.ts`, лежит рядом с юнит-тестом
  того же модуля) — настоящая инфраструктура (Postgres/Redis) и
  настоящий HTTP-слой (guards/pipes) через `supertest`, а не мок
  сервиса напрямую. Требует `pnpm infra:up` локально; в CI поднимается
  сервис-контейнерами (плюс отдельный шаг `prisma migrate deploy` для
  auth/catalog — см. `.github/workflows/ci.yml`). Примеры —
  `holds.lua.integration.spec.ts` и `holds.controller.integration.spec.ts`
  в `booking` (реальный Redis, атомарность Lua-скриптов и HTTP-слой
  отдельно), `main.integration.spec.ts` в `gateway` (то же приложение, что в проде,
  на фейковом апстриме и реальном Redis: список маршрутов, таймауты, лимит частоты,
  кеш, агрегация карты мест),
  `auth.integration.spec.ts` (реальный Postgres: ротация refresh-токена,
  массовый отзыв сессий, `ThrottlerGuard` на реальном запросе) и
  `catalog.integration.spec.ts` (`RolesGuard` + реальная инвалидация
  Redis-кэша при публикации события).
- **E2E** (Playwright, `packages/e2e`) — чёрный ящик через браузер
  поверх всех реально запущенных сервисов сразу, полные пользовательские
  сценарии: регистрация и восстановление сессии после reload
  (`auth.spec.ts`), организатор создаёт зал/места/событие и публикует
  его (`organizer-flow.spec.ts`), бронирование места с немедленным
  освобождением без ручного refresh (`seat-booking.spec.ts`), и два
  независимых браузерных контекста, где второй видит место занятым и
  получает 409 при прямой попытке через API (`seat-booking-two-users.spec.ts`).
  Требует уже поднятого стека (`pnpm dev` в каждом app, как локально,
  так и в CI-джобе `e2e`) — сам `playwright.config.ts` его не поднимает.
  Промоушен в ORGANIZER — только прямой доступ к Postgres
  (`tests/helpers/promote-organizer.ts`), в интерфейсе для этого
  сознательно нет кнопки. Фикстуры зала/события в `seat-booking*`
  подписывают JWT организатора напрямую (`tests/helpers/api-setup.ts`),
  не регистрируя его через `/api/auth/register` — у этого маршрута
  свой `ThrottlerGuard` (5 запросов/60с на IP, см. Фазу 4), и настоящая
  регистрация организатора в каждом тесте параллельного прогона быстро
  в него упирается.

`web` — Vitest + Testing Library (`apps/web/vitest.config.ts`), тот же
`pnpm test`, что и у бэкенд-пакетов на jest.

## Структура

```
apps/
  gateway/     единый публичный вход: список публичных маршрутов, лимит частоты
               на Redis, таймауты, кеш каталога, агрегация карты мест, прокси
               на auth, catalog, booking и payment (ADR 0007)
  auth/        регистрация, вход, JWT с ротацией refresh-токенов
  catalog/     залы, схемы мест, события, роли, кэш в Redis
  booking/     холды мест — только в Redis, без своей БД (ADR 0003)
  payment/     заказы, fake-провайдер оплаты, вебхуки, транзакционный outbox
  notification/ PDF-билеты с QR, письма, S3, RabbitMQ-consumer с DLQ
  web/         React-фронтенд (Vite)
packages/
  e2e/         Playwright — сценарии поверх уже поднятого стека
  load-test/   k6-сценарии нагрузочного тестирования
deploy/k8s/    локальный кластер kind — учебный трек по Kubernetes, не прод (ADR 0008)
docs/adr/      архитектурные решения и их причины
docker-compose.yml       локальная инфраструктура для разработки
docker-compose.prod.yml  боевой стек (запускается на сервере)
Caddyfile                reverse-proxy + автоматический HTTPS в проде
```

## Сервисы

| Сервис         | Отвечает за                                                        | Статус          |
| -------------- | ------------------------------------------------------------------ | --------------- |
| `gateway`      | Публичный вход: allowlist путей, rate limit, таймауты, кеш, прокси | в проде         |
| `auth`         | Пользователи, JWT, ротация refresh, rate limit                     | в проде         |
| `web`          | Фронтенд: вход, регистрация, личный кабинет                        | в проде         |
| `catalog`      | Залы, схемы мест, события, кэш в Redis                             | в проде         |
| `booking`      | Холды мест на время выбора (Redis, ADR 0003)                       | в проде         |
| `payment`      | Заказы, fake-провайдер, вебхуки, возвраты, сага                    | готово к деплою |
| `notification` | PDF-билеты с QR, письма (Resend), S3, DLQ                          | готово к деплою |

## API-документация

Swagger — отдельно на каждом сервисе, который отвечает наружу:

- [seatlock.fun/api/docs](https://seatlock.fun/api/docs) — `gateway`
- [seatlock.fun/api/auth/docs](https://seatlock.fun/api/auth/docs) — `auth` (виден через прокси gateway)
- [seatlock.fun/api/catalog/docs](https://seatlock.fun/api/catalog/docs) — `catalog` (виден через прокси gateway)
- [seatlock.fun/api/booking/docs](https://seatlock.fun/api/booking/docs) — `booking` (виден через прокси gateway)

Локально — `http://localhost:3000/api/docs`, `http://localhost:3001/api/auth/docs`,
`http://localhost:3002/api/catalog/docs`, `http://localhost:3003/api/booking/docs`.

## Продакшн

Всё крутится на одном арендованном сервере. **Caddy** — единственная программа,
которая напрямую видит интернет: сам получает и продлевает HTTPS-сертификат,
раздаёт статику фронтенда и проксирует `/api/*` на `gateway`.

```
seatlock.fun
    │
    ▼
[ Caddy ]  — HTTPS, один вход
 │       │
 │       └──▶ статика React (apps/web, залита по SCP)
 │
 └──▶ /api/* ──▶ [ gateway ×2 ] ──▶ [ auth ]      (только вход/регистрация)
        least_conn   │          ──▶ [ catalog ]   (залы и события, кеш публичных GET)
                     │          ──▶ [ booking ]   (холды мест — только Redis, без БД)
                     │          ──▶ [ payment ]   (заказы, вебхук провайдера)
                     │
                     └── сам: проверка JWT (/api/me), карта мест одним запросом
                         (/api/events/:id/seat-status), лимит частоты (общий Redis)
```

**Две реплики gateway** (`gateway`, `gateway-2`) за Caddy: пока одна перезапускается
при деплое (CD обновляет их по очереди) или упала, вторая принимает трафик. Пропускной
способности реплика не добавляет (на сервере два ядра), это защита от простоя.

**Деплой** — GitHub Actions ([.github/workflows/cd.yml](.github/workflows/cd.yml)) при
каждом пуше в `main`: собирает Docker-образы `gateway`/`auth`/`catalog`/`booking`/`payment`/`notification`,
публикует в `ghcr.io`, собирает и заливает статику `web` по SSH, применяет миграции Prisma отдельным шагом
(до перезапуска контейнеров), проверяет здоровье после деплоя.

Ветка `main` защищена — попасть туда можно только через Pull Request после
зелёного CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): форматирование,
линтер, типы, тесты, сборка.

## Наблюдаемость

Три инструмента, все самохостные, на проде доступны только с самого сервера (порты привязаны к
`127.0.0.1`, снаружи их нет):

| Инструмент | Что показывает                                                                 | dev                    |
| ---------- | ------------------------------------------------------------------------------ | ---------------------- |
| Grafana    | два дашборда: «SeatLock — overview» и «SeatLock — сервер и база»               | http://localhost:3006  |
| Prometheus | метрики сервисов, машины (`node-exporter`), контейнеров (`cAdvisor`), Postgres | http://localhost:9090  |
| Jaeger     | трейсы запросов насквозь: gateway → сервисы → очередь                          | http://localhost:16686 |

Дашборд «сервер и база» отвечает на вопросы «упёрлись ли мы в процессор или память» (включая
показатели давления PSI, они точнее load average), «кто из контейнеров ест ресурсы», «не кончились ли
соединения с базой», «не висят ли долгие транзакции». У каждого графика есть подсказка, что он
значит и что считать плохим.

Прод: `ssh -L 3016:localhost:3006 -L 16687:localhost:16686 deploy@<сервер>`, дальше
http://localhost:3016 (логин `admin`, пароль `GRAFANA_ADMIN_PASSWORD` из `.env` сервера) и
http://localhost:16687.

Ограничения, которые важно знать (ADR 0010): Jaeger хранит трейсы в памяти, поэтому их не больше
1500, а пишется 10% запросов; к Jaeger на проде не стоит слать запросы с большим `limit`, он на
одном сервере с остальным. Алертов пока нет: дашборды только показывают, никто не сообщает о проблеме сам.

## План по фазам

- [x] **00 — Скелет.** Монорепо, Docker, линтеры, CI, health-эндпоинты
- [x] **01 — Авторизация.** JWT с ротацией refresh, rate limit, React-скелет
- [x] **06 — Облако.** Свой сервер вместо AWS, Docker Compose, Caddy, полный CD _(раньше по плану — понадобилось для практики DevOps)_
- [x] **02 — Каталог.** Залы, схемы мест, события, роли (ORGANIZER/ADMIN), кэш в Redis
- [x] **03 — Бронирование.** Холды с TTL, конкурентность, нагрузочный тест
- [x] **04 — Платежи.** fake-провайдер (Stripe недоступен из Беларуси), вебхуки, сага, транзакционный outbox
- [x] **05 — Уведомления.** RabbitMQ, PDF с QR, S3, DLQ
- [x] **07 — Наблюдаемость.** Трейсинг, метрики сервисов, машины и базы, нагрузочный тест, документация

## Архитектурные решения

Причины ключевых решений записаны в [docs/adr](docs/adr).
