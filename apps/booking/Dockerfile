# syntax=docker/dockerfile:1

# --- Стадия 1: сборка --------------------------------------------------
FROM node:22-slim AS build
WORKDIR /repo

# npm install -g вместо "corepack enable": у corepack известный баг в Node 22
# (undici падает с assert(!this.paused) при скачивании пакета pnpm
# на некоторых сетях, включая раннеры GitHub Actions) — обходим его,
# ставя точную версию через обычный npm.
RUN npm install -g pnpm@11.25.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/booking/package.json apps/booking/
RUN pnpm install --frozen-lockfile

COPY apps/booking apps/booking
RUN pnpm --filter @seatlock/booking build

# --- Стадия 2: рантайм ---------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm@11.25.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/booking/package.json apps/booking/
RUN pnpm install --prod --frozen-lockfile --filter @seatlock/booking

COPY --from=build /repo/apps/booking/dist apps/booking/dist

USER node

WORKDIR /app/apps/booking
EXPOSE 3003

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3003/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
