# syntax=docker/dockerfile:1

# --- Стадия 1: сборка --------------------------------------------------
FROM node:22-slim AS build
WORKDIR /repo

RUN corepack enable

# schema.prisma нужен уже на этапе install: наш postinstall-скрипт
# сам вызывает "prisma generate", и ему нужно найти файл схемы —
# поэтому копируем prisma/ до pnpm install, а не вместе с остальным кодом.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/auth/package.json apps/auth/
COPY apps/auth/prisma apps/auth/prisma
RUN pnpm install --frozen-lockfile

COPY apps/auth apps/auth
RUN pnpm --filter @seatlock/auth build

# --- Стадия 2: рантайм ---------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/auth/package.json apps/auth/
COPY apps/auth/prisma apps/auth/prisma
RUN pnpm install --prod --frozen-lockfile --filter @seatlock/auth

COPY --from=build /repo/apps/auth/dist apps/auth/dist

USER node

WORKDIR /app/apps/auth
EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
