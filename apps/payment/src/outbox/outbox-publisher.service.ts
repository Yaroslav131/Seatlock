import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as amqp from 'amqplib';
import { outboxPublishTotal } from '../metrics/business-metrics';
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
 * mandatory:true — способ ЗНАТЬ, что событие некуда доставить (ни одна
 * очередь не привязана к payment.events): без него publishedAt
 * проставлялся бы как ни в чём не бывало, и событие тихо терялось бы
 * навсегда.
 */
@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RABBITMQ_CHANNEL) private readonly channel: amqp.ConfirmChannel,
  ) {}

  /**
   * Строки захватываются в транзакции через FOR UPDATE SKIP LOCKED: пока одна
   * копия payment (или предыдущий тик той же копии) публикует пачку, другая
   * эти строки пропускает, а не читает те же самые и не публикует их второй
   * раз. Блокировка снимается коммитом, то есть после того как publishedAt
   * проставлен.
   *
   * Всё равно "минимум один раз", а не "ровно один": если транзакция упадёт
   * после публикации, но до коммита, строки опубликуются повторно, поэтому
   * потребитель обязан быть идемпотентным (notification так и сделан).
   */
  @Interval(POLL_INTERVAL_MS)
  async publishPending(): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM outbox_events
          WHERE "publishedAt" IS NULL
          ORDER BY "createdAt" ASC
          LIMIT ${BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
        `;
        if (claimed.length === 0) {
          return;
        }

        const events = await tx.outboxEvent.findMany({
          where: { id: { in: claimed.map((row) => row.id) } },
          orderBy: { createdAt: 'asc' },
        });

        for (const event of events) {
          try {
            await this.publishConfirmed(
              event.eventType,
              Buffer.from(JSON.stringify(event.payload)),
              event.id,
            );
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { publishedAt: new Date() },
            });
            outboxPublishTotal.inc({ result: 'ok' });
          } catch (error) {
            if (error instanceof UnroutableMessageError) {
              // Ожидаемо, пока нет потребителя: не "ошибка", а состояние
              // "публиковать пока некому". publishedAt не проставляем: как
              // только появится очередь, следующий тик доставит успешно.
              outboxPublishTotal.inc({ result: 'unroutable' });
              this.logger.warn(
                `outbox-событие ${event.id} (${event.eventType}) некуда доставить — ни одна очередь не привязана к ${PAYMENT_EVENTS_EXCHANGE}`,
              );
              continue;
            }
            outboxPublishTotal.inc({ result: 'error' });
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `не удалось опубликовать outbox-событие ${event.id} (${event.eventType}): ${message} — попробую на следующем тике`,
            );
          }
        }
      },
      // Интерактивная транзакция по умолчанию живёт 5 секунд, а пачка из 50
      // публикаций с подтверждением брокера под нагрузкой может занять дольше.
      { timeout: 60_000 },
    );
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
