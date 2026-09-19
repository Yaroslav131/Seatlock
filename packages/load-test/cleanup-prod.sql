-- Очистка тестовых данных после нагрузочного прогона по проду.
-- Запускать на сервере: docker compose -f docker-compose.prod.yml exec -T postgres \
--   psql -U seatlock -d seatlock < packages/load-test/cleanup-prod.sql
--
-- Метки, по которым находятся тестовые данные (см. lib/fixtures.js):
--   * зал/событие: название начинается с '[LOADTEST]' (TEST_MARKER)
--   * заказы: userId начинается с 'k6-' (токены подписывает k6, реальных
--     пользователей с таким префиксом в auth нет)
--
-- По умолчанию скрипт заканчивается ROLLBACK — сначала посмотрите
-- счётчики, убедитесь, что удаляется только тестовое, и только потом
-- замените ROLLBACK на COMMIT.

BEGIN;

SELECT 'orders'        AS what, count(*) FROM payment.orders        WHERE "userId" LIKE 'k6-%'
UNION ALL
SELECT 'outbox_events',         count(*) FROM payment.outbox_events WHERE payload->>'userId' LIKE 'k6-%'
UNION ALL
SELECT 'events',                count(*) FROM catalog.events        WHERE title LIKE '[LOADTEST]%'
UNION ALL
SELECT 'venues',                count(*) FROM catalog.venues        WHERE name  LIKE '[LOADTEST]%';

DELETE FROM payment.outbox_events WHERE payload->>'userId' LIKE 'k6-%';
DELETE FROM payment.orders        WHERE "userId" LIKE 'k6-%';
-- Сначала события, потом залы: у events нет ON DELETE CASCADE на venue.
-- Места (seats) удаляются вместе с залом каскадом.
DELETE FROM catalog.events        WHERE title LIKE '[LOADTEST]%';
DELETE FROM catalog.venues        WHERE name  LIKE '[LOADTEST]%';

-- Redis-холды чистить не нужно: они сами истекают через SEAT_HOLD_TTL_SECONDS (300с).
-- Кэш каталога в Redis тоже протухает по своему TTL.

ROLLBACK; -- замените на COMMIT после проверки счётчиков выше
