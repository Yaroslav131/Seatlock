import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Прокси на gateway во время разработки — чтобы браузер видел API как
// тот же самый origin (localhost:5173), а не другой порт. Без этого
// httpOnly-cookie с refresh-токеном пришлось бы гонять как cross-site
// (SameSite=None, только по HTTPS) — так проще и ровно то же самое,
// что в проде сделает Caddy, отдавая фронт и API с одного домена.
const apiProxy = {
  '/api': { target: 'http://localhost:3000', changeOrigin: true },
  '/health': { target: 'http://localhost:3000', changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  // vite preview (сборка + статика, не dev-сервер) не наследует server.proxy —
  // это отдельная секция конфига. Нужна e2e-прогону в CI: там бэкенды
  // запускаются из dist/ (см. .github/workflows/ci.yml), а web — через
  // preview, а не watch-режим, чтобы не ждать холодную ts-node-компиляцию
  // 4 nest-приложений разом на слабом раннере.
  preview: {
    port: 5173,
    proxy: apiProxy,
  },
});
