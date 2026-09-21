import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import * as amqp from 'amqplib';

export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');
export const RABBITMQ_CHANNEL = Symbol('RABBITMQ_CHANNEL');

// Exchange уже объявлен в payment (см. apps/payment/src/rabbitmq/rabbitmq.module.ts)
// — notification им не владеет, но обязан объявить с теми же
// параметрами (assertExchange идемпотентен), иначе биндинг очереди
// ниже упадёт, если notification стартует раньше payment хоть раз.
// Имя переопределяется переменной окружения по той же причине, что и в payment:
// изоляция параллельных интеграционных тестов на общем брокере.
export const PAYMENT_EVENTS_EXCHANGE = process.env.PAYMENT_EVENTS_EXCHANGE ?? 'payment.events';

// DLQ: сообщение, которое consumer не смог обработать (недоступен
// auth/catalog/S3/SMTP), не должно теряться и не должно ретраиться
// бесконечно в основной очереди — nack(requeue:false) в
// order-paid.consumer.ts уводит его сюда через x-dead-letter-exchange.
// Ручной разбор/повторная публикация — по README ("DLQ" явно
// требуется фазой 05), без автоматического retry-цикла в первой версии.
export const NOTIFICATION_DLX = 'payment.events.dlx';
export const NOTIFICATION_DLQ = 'notification.order-paid.dlq';
export const ORDER_PAID_QUEUE = 'notification.order-paid';
export const ORDER_PAID_ROUTING_KEY = 'order.paid';

@Global()
@Module({
  providers: [
    {
      provide: RABBITMQ_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Promise<amqp.ChannelModel> =>
        amqp.connect(config.getOrThrow<string>('RABBITMQ_URL')),
    },
    {
      provide: RABBITMQ_CHANNEL,
      inject: [RABBITMQ_CONNECTION],
      useFactory: async (connection: amqp.ChannelModel): Promise<amqp.Channel> => {
        // Обычный канал, не confirm — в отличие от payment, notification
        // только потребляет, ничего не публикует, publisher confirms
        // тут не нужны.
        const channel = await connection.createChannel();
        await channel.assertExchange(PAYMENT_EVENTS_EXCHANGE, 'topic', { durable: true });

        await channel.assertExchange(NOTIFICATION_DLX, 'fanout', { durable: true });
        await channel.assertQueue(NOTIFICATION_DLQ, { durable: true });
        await channel.bindQueue(NOTIFICATION_DLQ, NOTIFICATION_DLX, '');

        await channel.assertQueue(ORDER_PAID_QUEUE, {
          durable: true,
          arguments: { 'x-dead-letter-exchange': NOTIFICATION_DLX },
        });
        await channel.bindQueue(ORDER_PAID_QUEUE, PAYMENT_EVENTS_EXCHANGE, ORDER_PAID_ROUTING_KEY);

        // Не хватать пачку сообщений разом, пока предыдущее не
        // подтверждено — при падении процесса до ack непринятые
        // сообщения просто вернутся в очередь для другого воркера,
        // а не потеряются пачкой.
        await channel.prefetch(1);

        return channel;
      },
    },
  ],
  exports: [RABBITMQ_CONNECTION, RABBITMQ_CHANNEL],
})
export class RabbitmqModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitmqModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`остановка (${signal ?? 'вручную'}) — закрываю rabbitmq`);
    const channel = this.moduleRef.get<amqp.Channel>(RABBITMQ_CHANNEL);
    const connection = this.moduleRef.get<amqp.ChannelModel>(RABBITMQ_CONNECTION);
    // Последовательно, не Promise.allSettled([...]) — канал дочерний
    // по отношению к соединению. Тот же самый hang в app.close(),
    // что нашли и починили в payment/src/rabbitmq/rabbitmq.module.ts:
    // при параллельном закрытии TCP соединения может порваться раньше,
    // чем брокер подтвердит закрытие канала, и промис channel.close()
    // никогда не резолвится. Сначала канал, потом соединение.
    try {
      await channel.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`не удалось штатно закрыть канал rabbitmq: ${message}`);
    }
    await connection.close();
  }
}
