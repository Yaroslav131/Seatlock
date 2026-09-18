import { Counter } from 'prom-client';

// result="conflict" — частичный уникальный индекс Postgres реально
// отклонил повторную покупку того же места (см. orders.service.ts).
export const ordersCreatedTotal = new Counter({
  name: 'orders_created_total',
  help: 'Попытки создать заказ',
  labelNames: ['result'],
});

// result="unroutable" — outbox-паблишер реально поймал сообщение, для
// которого нет привязанной очереди (см. outbox-publisher.service.ts).
export const outboxPublishTotal = new Counter({
  name: 'outbox_publish_total',
  help: 'Публикация outbox-событий в RabbitMQ',
  labelNames: ['result'],
});
