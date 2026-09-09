import { expect, test } from '@playwright/test';
import { createPublishedEventWithSeat, uniqueEmail } from './helpers/api-setup';

test('бронирование места: занял → отпустил → место сразу снова свободно, без ручного refresh', async ({
  page,
  request,
}) => {
  // Организатор/зал/событие заведены напрямую через API — этот тест
  // проверяет бронирование, не создание событий (то уже покрыто
  // organizer-flow.spec.ts).
  const fixture = await createPublishedEventWithSeat(request);

  const email = uniqueEmail('buyer');
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill('supersecret123');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto(`/events/${fixture.eventId}`);

  // rows: 1, seatsPerRow: 1 в фикстуре — ровно одно место.
  const seatButton = page.getByTitle('Ряд 1, место 1');
  await expect(seatButton).toBeVisible();
  await seatButton.click();

  await expect(page.getByText(/Место удержано за вами/)).toBeVisible();

  // Тот самый баг, что этим чатом чинили трижды за один день: после
  // release место должно немедленно стать кликабельным свободным —
  // не зависнуть занятым до ручного reload или следующего опроса.
  await page.getByRole('button', { name: 'Отпустить место' }).click();

  await expect(page.getByText(/Место удержано за вами/)).not.toBeVisible();
  await expect(seatButton).toBeEnabled();
});
