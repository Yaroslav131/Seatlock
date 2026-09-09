import { defineConfig, devices } from '@playwright/test';

// baseURL — уже поднятый стек (web + gateway + auth + catalog + booking),
// как локально через `pnpm dev` в каждом app, так и в CI. webServer тут
// нарочно не настроен: e2e проверяет систему целиком, поднимать её из
// самого playwright.config было бы отдельным (и более хрупким) слоем
// ответственности, чем просто "тесты бьют по уже работающему стеку".
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
