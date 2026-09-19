import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as amqp from 'amqplib';
import { Gauge } from 'prom-client';
import { ORDER_PAID_QUEUE, RABBITMQ_CONNECTION } from '../rabbitmq/rabbitmq.module';

// Consumer обрабатывает по одному сообщению (prefetch(1), см. rabbitmq.module.ts),
// поэтому под нагрузкой очередь растёт, если заказы оплачиваются быстрее, чем
// делаются PDF. Эта метрика показывает backlog прямо на графике.
@Injectable()
export class QueueDepthMetric implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueDepthMetric.name);

  constructor(@Inject(RABBITMQ_CONNECTION) private readonly connection: amqp.ChannelModel) {}

  async onApplicationBootstrap(): Promise<void> {
    // Отдельный канал: checkQueue на несуществующей очереди закрывает канал,
    // и это не должно задеть канал consumer'а.
    const channel = await this.connection.createChannel();
    const logger = this.logger;
    new Gauge({
      name: 'notification_order_paid_queue_messages',
      help: 'Сообщений в очереди order.paid, ещё не взятых в работу',
      async collect() {
        try {
          const { messageCount } = await channel.checkQueue(ORDER_PAID_QUEUE);
          this.set(messageCount);
        } catch (error) {
          logger.warn(`не удалось узнать длину очереди: ${String(error)}`);
        }
      },
    });
  }
}
