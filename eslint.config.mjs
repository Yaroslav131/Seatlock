import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Сгенерированный Prisma-клиент — не наш код, не должен
      // проверяться линтером (это минифицированный рантайм).
      '**/src/generated/**',
      // k6-скрипты выполняются в собственном JS-рантайме (Goja), не в
      // Node — глобалы вроде __ENV там объявляет сам k6, обычный eslint
      // это не знает и не должен (см. packages/load-test/README.md).
      'packages/load-test/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  prettier,
);
