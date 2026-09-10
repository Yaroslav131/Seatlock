import { expect, test } from '@playwright/test';
import { createPublishedEventWithSeat, uniqueEmail } from './helpers/api-setup';

const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? 'http://localhost:3000';

async function registerAndOpenEvent(
  browser: import('@playwright/test').Browser,
  eventId: string,
  emailPrefix: string,
): Promise<{
  context: import('@playwright/test').BrowserContext;
  page: import('@playwright/test').Page;
  email: string;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = uniqueEmail(emailPrefix);

  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill('supersecret123');
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto(`/events/${eventId}`);
  return { context, page, email };
}

test('два независимых пользователя: один держит место, другой видит его занятым и не может занять напрямую через API', async ({
  browser,
  request,
}) => {
  // Разные BrowserContext = разные cookie jar = два по-настоящему
  // независимых браузера, не два таба с одной сессией.
  const fixture = await createPublishedEventWithSeat(request);

  const userA = await registerAndOpenEvent(browser, fixture.eventId, 'buyer-a');
  const seatButtonA = userA.page.getByTitle('Ряд 1, место 1');
  await seatButtonA.click();
  await expect(userA.page.getByText(/Место удержано за вами/)).toBeVisible();

  const userB = await registerAndOpenEvent(browser, fixture.eventId, 'buyer-b');
  const seatButtonB = userB.page.getByTitle('Ряд 1, место 1');
  // B открыл страницу уже ПОСЛЕ того, как A занял место — первый же
  // опрос при монтировании SeatMap должен показать его серым, без
  // ожидания следующего 7-секундного цикла поллинга.
  await expect(seatButtonB).toBeDisabled();
  await expect(userB.page.getByText(/Место удержано за вами/)).not.toBeVisible();

  // Не только кнопка задизейблена в UI — сервер тоже должен отказать,
  // если B обратится напрямую к API в обход интерфейса. Токен берём
  // через /refresh (без throttle) через контекст B — у него уже есть
  // httpOnly refresh-cookie от собственной регистрации; отдельный
  // /login здесь тратил бы впустую бюджет ThrottlerGuard.
  const refreshResB = await userB.context.request.post(`${GATEWAY_URL}/api/auth/refresh`);
  const { accessToken } = (await refreshResB.json()) as { accessToken: string };

  const directHoldRes = await request.post(
    `${GATEWAY_URL}/api/booking/events/${fixture.eventId}/holds`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { seatId: fixture.seatId },
    },
  );
  expect(directHoldRes.status()).toBe(409);

  await userA.context.close();
  await userB.context.close();
});
