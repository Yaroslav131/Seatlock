import crypto from 'k6/crypto';
import { JWT_ACCESS_SECRET } from './fixtures.js';
import { signAccessToken } from './jwt.js';

// Покупатели, которые реально существуют в auth (посеяны seed-buyers.sql).
// Нужны, чтобы notification мог дойти до конца цепочки: он берёт email
// покупателя из auth и без настоящей записи падает с 404 ещё до PDF.
//
// id детерминированный: md5('k6-buyer-<i>') как UUID. Тот же расчёт делает
// seed-buyers.sql (md5(...)::uuid), поэтому k6 не нужен список id — индекса
// достаточно. Домен .invalid зарезервирован RFC 2606: notification не шлёт
// письма на @loadtest.invalid (см. apps/notification/src/mail/mail.service.ts).
export const BUYER_EMAIL_DOMAIN = '@loadtest.invalid';

export function buyerId(index) {
  const h = crypto.md5(`k6-buyer-${index}`, 'hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function signBuyerToken(index) {
  return signAccessToken(JWT_ACCESS_SECRET, {
    sub: buyerId(index),
    email: `k6-buyer-${index}${BUYER_EMAIL_DOMAIN}`,
    role: 'USER',
  });
}
