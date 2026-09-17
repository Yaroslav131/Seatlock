import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as amqp from 'amqplib';
import { PAYMENT_EVENTS_EXCHANGE, RABBITMQ_CHANNEL } from '../rabbitmq/rabbitmq.module';
import { PrismaService } from '../prisma/prisma.service';

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;

/** Брокер вернул сообщение как unroutable (mandatory:true) — ни одна очередь не привязана к exchange. */
class UnroutableMessageError extends Error {}

/**
 * Вторая половина transactional outbox: строки уже закоммичены рядом
 * со сменой статуса заказа (см. outbox.service.ts) — эта служба их
 * забирает и публикует в RabbitMQ по расписанию, тем же паттерном
 * @Interval/@Cron, что уже использует CleanupService в auth для
 * протухших refresh-токенов.
 *
 * Потребителя (notification) пока не существует — а значит, ни одна
 * очередь ещё не привязана к payment.events, и опубликованные сейчас
 * события физически некуда доставить (exchange без очереди ничего не
 * хранит, см. rabbitmq.module.ts). mandatory:true — не способ это
 * исправить (доставить всё равно некуда), а способ ЗНАТЬ об этом:
 * без него publishedAt проставлялся бы как ни в чём не бывало, и
 * событие тихо терялось бы навсегда.
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
        if (error instanceof UnroutableMessageError) {
          // Ожидаемо, пока нет notification — не "ошибка", а состояние
          // "публиковать пока некому". publishedAt не проставляем: как
          // только появится очередь, следующий тик доставит успешно.
          this.logger.warn(
            `outbox-событие ${event.id} (${event.eventType}) некуда доставить — ни одна очередь не привязана к ${PAYMENT_EVENTS_EXCHANGE}`,
          );
          continue;
        }
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
   *
   * confirm ack означает только "брокер обработал publish", а НЕ
   * "сообщение легло хоть в одну очередь" — exchange без привязанной
   * очереди спокойно подтвердит и тут же выбросит сообщение. mandatory:true
   * заставляет брокер, если доставить некуда, сначала прислать событие
   * 'return' на канал (и только потом всё равно придёт confirm ack) —
   * слушаем именно его, чтобы не принять "тихо потеряно" за "доставлено".
   */
  private publishConfirmed(routingKey: string, content: Buffer, messageId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let unroutable = false;

      const onReturn = (returned: amqp.Message): void => {
        if (returned.properties.messageId === messageId) {
          unroutable = true;
        }
      };
      this.channel.on('return', onReturn);

      this.channel.publish(
        PAYMENT_EVENTS_EXCHANGE,
        routingKey,
        content,
        { persistent: true, mandatory: true, contentType: 'application/json', messageId },
        (err) => {
          this.channel.removeListener('return', onReturn);
          if (unroutable) {
            reject(
              new UnroutableMessageError(`сообщение ${messageId} не доставлено ни в одну очередь`),
            );
          } else if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } else {
            resolve();
          }
        },
      );
    });
  }
}
