import { expect, test } from '@playwright/test';
import { createPublishedEventWithSeat } from './helpers/api-setup';
import { signInAsFixtureBuyer } from './helpers/fixture-buyer';

test('полный цикл покупки: занял место → оплатил (fake-провайдер) → видит подтверждение', async ({
  page,
  context,
  request,
}) => {
  // Организатор/зал/событие — та же фикстура, что и у seat-booking.spec.ts;
  // покупатель — тоже фикстура (см. helpers/fixture-buyer.ts), а не
  // настоящая регистрация через форму: этот тест проверяет оплату, не
  // регистрацию, и лишний /register при параллельном прогоне спецификаций
  // рискует упереться в общий ThrottlerGuard (5/60с на IP).
  const fixture = await createPublishedEventWithSeat(request);
  await signInAsFixtureBuyer(context);

  await page.goto(`/events/${fixture.eventId}`);

  const seatButton = page.getByTitle('Ряд 1, место 1');
  await expect(seatButton).toBeVisible();
  await seatButton.click();
  await expect(page.getByText(/Место удержано за вами/)).toBeVisible();

  await page.getByRole('button', { name: 'Перейти к оплате' }).click();
  await expect(page).toHaveURL(new RegExp(`/events/${fixture.eventId}/checkout\\?seatId=`));

  await page.getByRole('button', { name: 'Оплатить' }).click();

  await expect(page.getByText(/Оплата прошла успешно/)).toBeVisible();
});
