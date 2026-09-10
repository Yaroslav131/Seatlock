import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Явный вызов, а не test.globals: true в конфиге — в проекте принято
// явно импортировать describe/it/expect, а не полагаться на глобалы.
// Без этого автоочистка @testing-library/react между тестами не
// срабатывает (она сама себя регистрирует только если видит настоящий
// globalThis.afterEach), и рендеры накапливаются в одном document.body.
afterEach(() => {
  cleanup();
});
