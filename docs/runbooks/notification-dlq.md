# Билеты в DLQ: разбор и повторная отправка

Сообщение `order.paid` попадает в DLQ (`notification.order-paid.dlq`), если `notification` не смог
выдать билет: недоступен `catalog` или `auth`, упал S3, отказал SMTP. Заказ при этом оплачен,
не хватает только билета. Потерь нет: сообщение лежит в DLQ, а в `notification_logs` строка
со статусом `FAILED` и причиной.

## 1. Понять причину

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U seatlock -d seatlock -c \
  "select \"orderId\", left(\"errorMessage\", 80) as err, \"createdAt\" from notification.notification_logs where status = 'FAILED' order by \"createdAt\" desc limit 20"
```

Сначала почините причину (поднимите сервис, проверьте S3 и SMTP). Иначе сообщения
после повтора снова окажутся в DLQ.

## 2. Посмотреть, что лежит в DLQ (ничего не меняет)

```bash
docker compose -f docker-compose.prod.yml exec -T notification node dist/scripts/replay-dlq.js --dry-run
```

Покажет число сообщений и `orderId` первых из них. Сообщения остаются в DLQ на прежних местах.

## 3. Вернуть сообщения в работу

```bash
docker compose -f docker-compose.prod.yml exec -T notification node dist/scripts/replay-dlq.js --limit=50
```

Сообщения переносятся в очередь `notification.order-paid` (только в неё: другие потребители
события ничего не получают повторно) и обрабатываются заново. По умолчанию `--limit=100`.

## 4. Проверить

Повторите запрос из шага 1: заказы должны перейти в `SENT`. Очередь DLQ уменьшилась
на число перенесённых сообщений.

## Почему повтор безопасен

- Заказ захватывается атомарным SQL-запросом: заказ в `SENT` повторно не обрабатывается,
  два воркера не отправят по письму.
- Захватить можно строку в `FAILED` (это и есть повтор) и `PROCESSING` с истёкшей арендой (воркер упал).
- Сообщение подтверждается в DLQ только после того, как брокер подтвердил его публикацию
  в рабочую очередь: при сбое посередине оно останется в DLQ и будет перенесено ещё раз,
  а дубль безвреден.
