-- Очистка тестовых данных после нагрузочного прогона (dev или прод).
-- Запуск: docker compose -f docker-compose.prod.yml exec -T postgres \
--   psql -U seatlock -d seatlock < packages/load-test/cleanup-prod.sql
--
-- Метки, по которым находятся тестовые данные (см. lib/fixtures.js, lib/buyers.js):
--   * зал/событие: название начинается с '[LOADTEST]' (TEST_MARKER)
--   * заказы: userId начинается с 'k6-' (вымышленные покупатели) либо совпадает
--     с id посеянного покупателя (email на @loadtest.invalid)
--   * посеянные покупатели: email вида k6-buyer-<i>@loadtest.invalid
--
-- По умолчанию скрипт заканчивается ROLLBACK — сначала посмотрите
-- счётчики, убедитесь, что удаляется только тестовое, и только потом
-- замените ROLLBACK на COMMIT.
--
-- Этот скрипт чистит только Postgres. Отдельно, вне SQL (команды в
-- packages/load-test/README.md, раздел «Очистка»): PDF-билеты в MinIO,
-- очередь order.paid и DLQ в RabbitMQ.

BEGIN;

CREATE TEMP TABLE test_orders AS
SELECT id FROM payment.orders
WHERE "userId" LIKE 'k6-%'
   OR "userId" IN (SELECT id FROM auth.users WHERE email LIKE '%@loadtest.invalid');

SELECT 'orders'                AS what, count(*) FROM test_orders
UNION ALL
SELECT 'notification_logs',    count(*) FROM notification.notification_logs WHERE "orderId" IN (SELECT id FROM test_orders)
UNION ALL
SELECT 'outbox_events',        count(*) FROM payment.outbox_events
  WHERE payload->>'orderId' IN (SELECT id FROM test_orders)
UNION ALL
SELECT 'events',               count(*) FROM catalog.events WHERE title LIKE '[LOADTEST]%'
UNION ALL
SELECT 'venues',               count(*) FROM catalog.venues WHERE name  LIKE '[LOADTEST]%'
UNION ALL
SELECT 'seeded_buyers',        count(*) FROM auth.users WHERE email LIKE '%@loadtest.invalid';

DELETE FROM notification.notification_logs WHERE "orderId" IN (SELECT id FROM test_orders);
DELETE FROM payment.outbox_events          WHERE payload->>'orderId' IN (SELECT id FROM test_orders);
DELETE FROM payment.orders                 WHERE id IN (SELECT id FROM test_orders);
-- Сначала события, потом залы: у events нет ON DELETE CASCADE на venue.
-- Места (seats) удаляются вместе с залом каскадом.
DELETE FROM catalog.events                 WHERE title LIKE '[LOADTEST]%';
DELETE FROM catalog.venues                 WHERE name  LIKE '[LOADTEST]%';
-- refresh_tokens удаляются каскадом (у посеянных их нет, но правило общее).
DELETE FROM auth.users                     WHERE email LIKE '%@loadtest.invalid';

-- Redis-холды чистить не нужно: они сами истекают через SEAT_HOLD_TTL_SECONDS (300с).
-- Кэш каталога в Redis тоже протухает по своему TTL.

ROLLBACK; -- замените на COMMIT после проверки счётчиков выше
