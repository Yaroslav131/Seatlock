# syntax=docker/dockerfile:1

# --- Стадия 1: сборка --------------------------------------------------
FROM node:22-slim AS build
WORKDIR /repo

# npm install -g вместо "corepack enable": у corepack известный баг в Node 22
# (undici падает с assert(!this.paused) при скачивании пакета pnpm
# на некоторых сетях, включая раннеры GitHub Actions) — обходим его,
# ставя точную версию через обычный npm.
RUN npm install -g pnpm@11.25.0

# schema.prisma нужен уже на этапе install: наш postinstall-скрипт
# сам вызывает "prisma generate", и ему нужно найти файл схемы —
# поэтому копируем prisma/ до pnpm install, а не вместе с остальным кодом.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/catalog/package.json apps/catalog/
COPY apps/catalog/prisma apps/catalog/prisma
RUN pnpm install --frozen-lockfile

COPY apps/catalog apps/catalog
RUN pnpm --filter @seatlock/catalog build

# --- Стадия 2: рантайм ---------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm@11.25.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/catalog/package.json apps/catalog/
COPY apps/catalog/prisma apps/catalog/prisma
RUN pnpm install --prod --frozen-lockfile --filter @seatlock/catalog

COPY --from=build /repo/apps/catalog/dist apps/catalog/dist

# dist/generated только что приехал из build-стадии (node:22-slim,
# Debian) — движок Prisma внутри него не подходит для alpine (musl).
# Установка чуть выше уже сгенерировала правильный клиент под эту
# стадию в src/generated — переносим его поверх, вместо того что
# приехало из build. Это баг, который реально ловили на auth —
# без этого шага сервис падает при старте с "wrong query engine".
RUN rm -rf apps/catalog/dist/generated \
  && cp -r apps/catalog/src/generated apps/catalog/dist/generated

USER node

WORKDIR /app/apps/catalog
EXPOSE 3002

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
