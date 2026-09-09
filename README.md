# SeatLock

Продажа билетов на мероприятия с бронированием конкретных мест.
Учебный микросервисный проект: NestJS, PostgreSQL, Redis, RabbitMQ, React, Stripe.

Ключевая задача проекта — **не продать одно место дважды** при сотнях одновременных
запросов. Всё остальное строится вокруг этого инварианта.

**Продакшн:** [seatlock.fun](https://seatlock.fun)

## Стек

| Слой               | Технологии                                         |
| ------------------ | -------------------------------------------------- |
| Бэкенд             | NestJS 11, TypeScript, Prisma                      |
| Основная база      | PostgreSQL 17 (своя схема на каждый сервис)        |
| Кэш и холды мест   | Redis 7                                            |
| Очереди            | RabbitMQ 4                                         |
| Журнал уведомлений | MongoDB 8                                          |
| Файлы              | S3 (локально — MinIO)                              |
| Платежи            | Stripe (тестовый режим)                            |
| Фронтенд           | React 19, Vite, TypeScript, Zustand                |
| Инфраструктура     | Docker, GitHub Actions (CI/CD), Caddy, свой сервер |

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

| Сервис     | Порт        | Веб-интерфейс                                  |
| ---------- | ----------- | ---------------------------------------------- |
| web        | 5173        | http://localhost:5173                          |
| gateway    | 3000        | —                                              |
| auth       | 3001        | —                                              |
| catalog    | 3002        | —                                              |
| booking    | 3003        | —                                              |
| PostgreSQL | 5433        | —                                              |
| Redis      | 6380        | —                                              |
| RabbitMQ   | 5673        | http://localhost:15673 (seatlock / seatlock)   |
| MongoDB    | 27018       | —                                              |
| MinIO      | 9100        | http://localhost:9101 (seatlock / seatlock123) |
| Mailpit    | 1026 (SMTP) | http://localhost:8026                          |

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
  отдельно), `main.integration.spec.ts` в `gateway` (прокси на фейковый
  апстрим + `/api/me`, без юнит-слоя — у gateway это единственный тест),
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
  gateway/     единый публичный вход: REST, проверка JWT, rate limit,
               прозрачный прокси на auth, catalog и booking
  auth/        регистрация, вход, JWT с ротацией refresh-токенов
  catalog/     залы, схемы мест, события, роли, кэш в Redis
  booking/     холды мест — только в Redis, без своей БД (ADR 0003)
  web/         React-фронтенд (Vite)
packages/
  e2e/         Playwright — сценарии поверх уже поднятого стека
docs/adr/      архитектурные решения и их причины
docker-compose.yml       локальная инфраструктура для разработки
docker-compose.prod.yml  боевой стек (запускается на сервере)
Caddyfile                reverse-proxy + автоматический HTTPS в проде
```

## Сервисы

| Сервис         | Отвечает за                                            | Статус      |
| -------------- | ------------------------------------------------------ | ----------- |
| `gateway`      | Публичный вход, health-эндпоинты, проверка JWT, прокси | в проде     |
| `auth`         | Пользователи, JWT, ротация refresh, rate limit         | в проде     |
| `web`          | Фронтенд: вход, регистрация, личный кабинет            | в проде     |
| `catalog`      | Залы, схемы мест, события, кэш в Redis                 | в проде     |
| `booking`      | Холды мест на время выбора (Redis, ADR 0003)           | в проде     |
| `payment`      | Заказы, Stripe, вебхуки, возвраты                      | планируется |
| `notification` | PDF-билеты, письма                                     | планируется |

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
 └──▶ /api/* ──▶ [ gateway ] ──▶ [ auth ]      (только вход/регистрация)
                     │       ──▶ [ catalog ]   (создание залов/событий — RolesGuard)
                     │       ──▶ [ booking ]   (холды мест — только Redis, без БД)
                     │
                     └── сам проверяет JWT для остального (например, /api/me)
```

**Деплой** — GitHub Actions ([.github/workflows/cd.yml](.github/workflows/cd.yml)) при
каждом пуше в `main`: собирает Docker-образы `gateway`/`auth`/`catalog`/`booking`, публикует в `ghcr.io`,
собирает и заливает статику `web` по SSH, применяет миграции Prisma отдельным шагом
(до перезапуска контейнеров), проверяет здоровье после деплоя.

Ветка `main` защищена — попасть туда можно только через Pull Request после
зелёного CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)): форматирование,
линтер, типы, тесты, сборка.

## План по фазам

- [x] **00 — Скелет.** Монорепо, Docker, линтеры, CI, health-эндпоинты
- [x] **01 — Авторизация.** JWT с ротацией refresh, rate limit, React-скелет
- [x] **06 — Облако.** Свой сервер вместо AWS, Docker Compose, Caddy, полный CD _(раньше по плану — понадобилось для практики DevOps)_
- [x] **02 — Каталог.** Залы, схемы мест, события, роли (ORGANIZER/ADMIN), кэш в Redis
- [ ] **03 — Бронирование.** Холды с TTL, конкурентность, нагрузочный тест
- [ ] **04 — Платежи.** Stripe, вебхуки, сага, транзакционный outbox
- [ ] **05 — Уведомления.** RabbitMQ, PDF с QR, S3, DLQ
- [ ] **07 — Наблюдаемость.** Трейсинг, метрики, нагрузочный тест, документация

## Архитектурные решения

Причины ключевых решений записаны в [docs/adr](docs/adr).
