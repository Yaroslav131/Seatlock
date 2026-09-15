import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as amqp from 'amqplib';
import { PAYMENT_EVENTS_EXCHANGE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { PrismaService } from '../prisma/prisma.service';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;

/**
 * Вторая половина transactional outbox: строки уже закоммичены рядом
 * со сменой статуса заказа (см. outbox.service.ts) — эта служба их
 * забирает и публикует в RabbitMQ по расписанию, тем же паттерном
 * @Interval/@Cron, что уже использует CleanupService в auth для
 * протухших refresh-токенов. Потребителя пока нет (notification —
 * отдельная будущая фаза) — сообщения просто копятся в durable-очереди.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: amqp.ConfirmChannel,
  ) {}

  @Interval(POLL_INTERVAL_MS)
  async publishPending(): Promise<void> {
    const events = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    for (const event of events) {
      try {
        await this.publishConfirmed(
          event.eventType,
          Buffer.from(JSON.stringify(event.payload)),
          event.id,
        );
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date() },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `не удалось опубликовать outbox-событие ${event.id} (${event.eventType}): ${message} — попробую на следующем тике`,
        );
      }
    }
  }

  /**
   * confirmChannel.publish() сам по себе синхронный и буферизует
   * запись — колбэк срабатывает только после подтверждения (ack) от
   * самого RabbitMQ, что сообщение реально принято. Промисифицируем
   * именно этот колбэк, а не просто вызов publish(), иначе гарантия
   * теряется.
   */
  private publishConfirmed(routingKey: string, content: Buffer, messageId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.channel.publish(
        PAYMENT_EVENTS_EXCHANGE,
        routingKey,
        content,
        { persistent: true, contentType: 'application/json', messageId },
        (err) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } else {
            resolve();
          }
        },
      );
    });
  }
}
