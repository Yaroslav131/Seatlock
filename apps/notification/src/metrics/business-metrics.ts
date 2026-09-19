import { Counter } from 'prom-client';

// result="failed" — сообщение реально ушло в DLQ (см. order-paid.consumer.ts).
export const orderPaidProcessedTotal = new Counter({
  name: 'order_paid_processed_total',
  help: 'Обработка order.paid из RabbitMQ',
  labelNames: ['result'],
});

// Письма, которые сознательно не отправлены: получатель на зарезервированном
// домене нагрузочного теста (см. mail.service.ts). PDF и загрузка в S3 для
// них выполняются как обычно.
export const ticketMailSuppressedTotal = new Counter({
  name: 'ticket_mail_suppressed_total',
  help: 'Письма с билетом, не отправленные из-за тестового домена получателя',
});
