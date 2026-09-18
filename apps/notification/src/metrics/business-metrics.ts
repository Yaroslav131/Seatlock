import { Counter } from 'prom-client';

// result="failed" — сообщение реально ушло в DLQ (см. order-paid.consumer.ts).
export const orderPaidProcessedTotal = new Counter({
  name: 'order_paid_processed_total',
  help: 'Обработка order.paid из RabbitMQ',
  labelNames: ['result'],
});
