import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import * as amqp from 'amqplib';

export const RABBITMQ_CONNECTION = Symbol('RABBITMQ_CONNECTION');
export const RABBITMQ_CHANNEL = Symbol('RABBITMQ_CHANNEL');

// Первое реальное использование RabbitMQ в проекте — до сих пор он был
// поднят в docker-compose, но ни один сервис к нему не подключался.
// Потребителя (notification) пока не существует — outbox просто
// копит сообщения в durable-очереди, RabbitMQ их не теряет.
export const PAYMENT_EVENTS_EXCHANGE = 'payment.events';

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
      useFactory: async (connection: amqp.ChannelModel): Promise<amqp.ConfirmChannel> => {
        // Confirm-канал, а не обычный: publish() сам по себе синхронный
        // и ничего не гарантирует (буферизует запись и тут же
        // возвращается) — без publisher confirms outbox-паблишер мог бы
        // пометить событие опубликованным ДО того, как брокер реально
        // его принял. confirmChannel даёт callback, который срабатывает
        // только после подтверждения от RabbitMQ — см. outbox-publisher.service.ts.
        const channel = await connection.createConfirmChannel();
        // durable — переживает перезапуск RabbitMQ; сообщения публикуем
        // с persistent:true (см. outbox-publisher.service.ts) — иначе
        // durable-очередь сама по себе от потери сообщений не спасает.
        await channel.assertExchange(PAYMENT_EVENTS_EXCHANGE, 'topic', { durable: true });
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
    const channel = this.moduleRef.get<amqp.ConfirmChannel>(RABBITMQ_CHANNEL);
    const connection = this.moduleRef.get<amqp.ChannelModel>(RABBITMQ_CONNECTION);
    // Последовательно, не Promise.allSettled([...]) — канал дочерний
    // по отношению к соединению. Закрытие обоих параллельно реально
    // подвешивало app.close() навсегда: если TCP соединения уже нет к
    // моменту, когда брокер должен был бы подтвердить закрытие канала
    // (channel.close-ok), этот промис никогда не резолвится. Сначала
    // канал, потом соединение — ту же гонку словили и починили при
    // отладке этого файла.
    try {
      await channel.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`не удалось штатно закрыть канал rabbitmq: ${message}`);
    }
    await connection.close();
  }
}
