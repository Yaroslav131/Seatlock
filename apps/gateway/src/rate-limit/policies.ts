import type { RatePolicyName } from '../proxy/routes';

export interface RatePolicy {
  limit: number;
  windowMs: number;
}

/**
 * Лимиты на один IP за окно. Значения рассчитаны на живого человека в браузере:
 * карта мест опрашивает раз в 7 секунд (это ~9 запросов в минуту с агрегацией и втрое
 * больше без неё), а «дорогие» действия (логин, заказ, занятие места) человек
 * совершает единицы раз в минуту. Для нагрузочных тестов с одного адреса лимит
 * отключается через RATE_LIMIT_BYPASS_IPS, а не завышением здесь.
 */
export const RATE_POLICIES: Record<Exclude<RatePolicyName, 'exempt'>, RatePolicy> = {
  // Вход и регистрация: защита от перебора паролей. У auth свой, более строгий лимит
  // (5 в минуту на каждый из двух путей, in-memory на каждую реплику отдельно); этот
  // общий для обоих путей и всех реплик gateway, поэтому он вдвое выше и лишь страхует.
  credentials: { limit: 20, windowMs: 60_000 },
  orders: { limit: 30, windowMs: 60_000 },
  holds: { limit: 60, windowMs: 60_000 },
  default: { limit: 600, windowMs: 60_000 },
};
