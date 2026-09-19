-- Посев покупателей для нагрузочного теста (stress-test.js, BUYER_POOL=N).
--
-- Зачем: notification берёт email покупателя из auth. Вымышленных
-- покупателей там нет, и цепочка обрывается на 404 до PDF. Эти пользователи
-- настоящие записи, поэтому PDF, загрузка в S3 и лог выполняются по-настоящему.
-- Письма не уходят: домен @loadtest.invalid зарезервирован RFC 2606, и
-- notification не отправляет на него почту (mail.service.ts).
--
-- id = md5('k6-buyer-<i>')::uuid — тот же расчёт делает k6 (lib/buyers.js),
-- поэтому список id k6 не нужен. Повторный запуск безопасен (ON CONFLICT).
--
-- Запуск (N = 2000 по умолчанию, меняется через -v n=...):
--   dev:  docker exec -i seatlock-postgres psql -U seatlock -d seatlock -v n=2000 < packages/load-test/seed-buyers.sql
--   prod: docker compose -f docker-compose.prod.yml exec -T postgres \
--           psql -U seatlock -d seatlock -v n=2000 < packages/load-test/seed-buyers.sql

\if :{?n}
\else
  \set n 2000
\endif

INSERT INTO auth.users (id, email, "passwordHash", role, "updatedAt")
SELECT md5('k6-buyer-' || i)::uuid::text,
       'k6-buyer-' || i || '@loadtest.invalid',
       'unused', -- логин этими пользователями не выполняется, хеш не проверяется
       'USER',
       now()
FROM generate_series(0, :n - 1) AS i
ON CONFLICT (id) DO NOTHING;

SELECT count(*) AS seeded_buyers FROM auth.users WHERE email LIKE 'k6-buyer-%@loadtest.invalid';
