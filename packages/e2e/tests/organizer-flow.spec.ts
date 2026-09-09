import { expect, test } from '@playwright/test';
import { uniqueEmail } from './helpers/api-setup';
import { promoteToOrganizer } from './helpers/promote-organizer';

test('организатор создаёт зал, места и событие, публикует его — оно видно в публичной ленте', async ({
  page,
}) => {
  const email = uniqueEmail('organizer');
  const password = 'supersecret123';
  const venueName = `Дворец спорта ${Date.now()}`;
  const eventTitle = `Концерт ${Date.now()}`;

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Роль зашита в JWT на момент выдачи (см. AuthService.issueTokenPair) —
  // токен, полученный ДО промоушена, всё ещё несёт role: USER. В UI нет
  // способа стать организатором (осознанное решение продукта), поэтому
  // правим роль напрямую в базе и логинимся заново за свежим токеном —
  // ровно то, что сделал бы настоящий админ.
  await promoteToOrganizer(email);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole('link', { name: 'Кабинет организатора' }).click();
  await expect(page).toHaveURL(/\/organizer$/);

  await page.getByLabel('Название', { exact: true }).fill(venueName);
  await page.getByLabel('Город').fill('Минск');
  await page.getByLabel('Адрес').fill('пр. Победителей, 1');
  await page.getByRole('button', { name: 'Создать зал' }).click();

  const venueRow = page.locator('li').filter({ hasText: venueName });
  await expect(venueRow.getByText('0 мест')).toBeVisible();

  await venueRow.getByRole('button', { name: '+ Места' }).click();
  await page.getByLabel('Рядов').fill('2');
  await page.getByLabel('Мест в ряду').fill('3');
  await page.getByRole('button', { name: 'Сгенерировать' }).click();
  await expect(venueRow.getByText('6 мест')).toBeVisible();

  await page.getByLabel('Зал').selectOption({ label: `${venueName} (Минск)` });
  await page.getByLabel('Название события').fill(eventTitle);
  await page.getByLabel('Дата и время').fill('2026-12-20T19:00');
  await page.getByLabel('Цена, ₽').fill('1500');
  await page.getByRole('button', { name: 'Создать черновик' }).click();

  const eventRow = page.locator('li').filter({ hasText: eventTitle });
  await expect(eventRow.getByText('Черновик')).toBeVisible();

  await eventRow.getByRole('button', { name: 'Опубликовать' }).click();
  await expect(eventRow.getByText('Опубликовано')).toBeVisible();

  await page.getByRole('link', { name: 'События' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText(eventTitle)).toBeVisible();
});
