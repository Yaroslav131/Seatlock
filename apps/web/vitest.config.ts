import { defineConfig } from 'vitest/config';

// Отдельный конфиг, а не mergeConfig поверх vite.config.ts: dev-сервер
// (порт, прокси на gateway) тестам не нужен. Без плагинов вообще —
// Vite сам транспилирует .tsx через esbuild по jsx-настройке из
// tsconfig.json ("react-jsx"), отдельный @vitejs/plugin-react тут
// только для Fast Refresh, тестам не нужного. Заодно так не сталкиваем
// его типы (vite 6, как в apps/web) с типами vitest/config (тянет vite
// 5 как внутреннюю зависимость) — конфликт всплывал только на tsc,
// в рантайме оба варианта работают одинаково.
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});
