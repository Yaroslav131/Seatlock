import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers/api-setup';

test.describe('регистрация и восстановление сессии', () => {
  test('регистрация ведёт в личный кабинет, а перезагрузка страницы не разлогинивает', async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto('/register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Пароль').fill('supersecret123');
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(email)).toBeVisible();

    // Access-токен живёт только в памяти вкладки (apps/web/src/lib/auth-store.ts) —
    // reload его стирает. Проверяем то же, что и настоящий баг из самого
    // начала проекта: httpOnly refresh-cookie должна тихо восстановить
    // сессию через App.tsx, а не выкинуть на /login.
    await page.reload();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(email)).toBeVisible();
  });

  test('вход несуществующим email — тот же общий текст ошибки, без регистрации заранее', async ({
    page,
  }) => {
    // AuthService.login нарочно отвечает одинаково и на несуществующий
    // email, и на неверный пароль (см. auth.integration.spec.ts) —
    // поэтому тест не тратит бюджет ThrottlerGuard на /register: почти
    // наверняка несуществующий email проверяет то же самое поведение.
    await page.goto('/login');
    await page.getByLabel('Email').fill(uniqueEmail());
    await page.getByLabel('Пароль').fill('любой-пароль');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('Неверный email или пароль')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
