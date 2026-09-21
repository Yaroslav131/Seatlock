// Свой exchange для тестов: payment и notification гоняют интеграционные тесты
// параллельно на одном RabbitMQ, и без изоляции события order.paid из тестов
// payment попадали бы в очередь notification и замедляли её тесты.
process.env.PAYMENT_EVENTS_EXCHANGE ??= 'payment.events.test-notification';
