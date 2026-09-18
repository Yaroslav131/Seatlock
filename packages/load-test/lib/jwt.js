import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

// Сервисы (см. apps/*/src/auth/jwt-auth.guard.ts) проверяют только подпись
// общим JWT_ACCESS_SECRET — к auth за проверкой не ходят, точно так же, как
// e2e-фикстуры (packages/e2e/tests/helpers/api-setup.ts) подписывают токены
// напрямую, в обход /register и /login. k6 — не Node, готовой библиотеки
// jsonwebtoken тут нет, поэтому HS256 собирается вручную из двух
// примитивов стандартной библиотеки k6: crypto.hmac и encoding.b64encode.
export function signAccessToken(secret, payload, expiresInSeconds = 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = encoding.b64encode(JSON.stringify(header), 'rawurl');
  const payloadB64 = encoding.b64encode(JSON.stringify(fullPayload), 'rawurl');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto.hmac('sha256', secret, signingInput, 'base64rawurl');

  return `${signingInput}.${signature}`;
}
