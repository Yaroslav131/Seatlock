# syntax=docker/dockerfile:1

# --- Стадия 1: сборка --------------------------------------------------
# Тут нужен полноценный node:22, потому что pnpm и nest build требуют
# devDependencies и системные инструменты, которых нет в alpine-образе.
FROM node:22-slim AS build
WORKDIR /repo

RUN corepack enable

# Сначала копируем только файлы, от которых зависит установка пакетов.
# Так Docker закэширует слой pnpm install и не будет пересобирать его
# при каждом изменении исходного кода — только когда меняются зависимости.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile

COPY apps/gateway apps/gateway
RUN pnpm --filter @seatlock/gateway build

# --- Стадия 2: рантайм ---------------------------------------------------
# node:22-alpine в разы легче node:22-slim: там, где сборка занимает
# 1+ ГБ (компиляторы, кэш pnpm), рантайму нужен только сам Node
# и уже скомпилированный JS.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --prod --frozen-lockfile --filter @seatlock/gateway

COPY --from=build /repo/apps/gateway/dist apps/gateway/dist

# node:22-alpine уже содержит непривилегированного пользователя "node" —
# не создаём своего, а просто переключаемся на готового.
USER node

WORKDIR /app/apps/gateway
EXPOSE 3000

# Проверка здоровья самим Docker'ом — если /health не отвечает,
# оркестратор увидит контейнер как unhealthy и не будет слать туда трафик.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
