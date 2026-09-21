import * as amqp from 'amqplib';
import { NOTIFICATION_DLQ, ORDER_PAID_QUEUE } from '../rabbitmq/rabbitmq.module';

export interface ReplayOptions {
  /** Сколько сообщений обработать за запуск: защита от бесконечного цикла, если они снова падают. */
  limit: number;
  /** Только показать, что лежит в DLQ, ничего не переносить. */
  dryRun: boolean;
}

export interface ReplayResult {
  /** Сообщений в DLQ на момент запуска. */
  inQueue: number;
  /** Сколько перенесено обратно в очередь (в dry-run: сколько просмотрено). */
  processed: number;
  /** orderId просмотренных сообщений (для отчёта оператору). */
  orderIds: string[];
}

function readOrderId(msg: amqp.GetMessage): string {
  try {
    const parsed = JSON.parse(msg.content.toString('utf-8')) as { orderId?: unknown };
    return typeof parsed.orderId === 'string' ? parsed.orderId : '(нет orderId)';
  } catch {
    return '(нечитаемое сообщение)';
  }
}

function sendToQueueConfirmed(
  channel: amqp.ConfirmChannel,
  queue: string,
  content: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(
      queue,
      content,
      { persistent: true, contentType: 'application/json' },
      (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve()),
    );
  });
}

/**
 * Возвращает сообщения из DLQ в рабочую очередь notification, чтобы их
 * обработали заново (после починки причины: недоступный catalog/auth, SMTP).
 *
 * Кладём прямо в очередь notification, а не в exchange payment.events: иначе
 * другие потребители order.paid получили бы второй экземпляр события, которое
 * они давно обработали. Сначала публикация с подтверждением брокера, потом ack
 * в DLQ: при сбое между ними сообщение останется в DLQ и будет перенесено ещё
 * раз, а дубль безвреден: захват заказа (order-paid.consumer.ts, claim())
 * не даст отправить второе письмо.
 *
 * В dry-run сообщения читаются, но не переносятся и возвращаются в DLQ.
 */
export async function replayDeadLetters(
  channel: amqp.ConfirmChannel,
  { limit, dryRun }: ReplayOptions,
): Promise<ReplayResult> {
  const { messageCount } = await channel.checkQueue(NOTIFICATION_DLQ);
  // Целевая очередь должна существовать: sendToQueue в несуществующую молча
  // выбросит сообщение, а мы уже подтвердили бы его в DLQ.
  await channel.checkQueue(ORDER_PAID_QUEUE);

  const toRead = Math.min(limit, messageCount);
  const held: amqp.GetMessage[] = [];
  const orderIds: string[] = [];
  let moved = 0;

  for (let i = 0; i < toRead; i++) {
    const msg = await channel.get(NOTIFICATION_DLQ, { noAck: false });
    if (!msg) {
      break;
    }
    orderIds.push(readOrderId(msg));

    if (dryRun) {
      held.push(msg);
      continue;
    }
    await sendToQueueConfirmed(channel, ORDER_PAID_QUEUE, msg.content);
    channel.ack(msg);
    moved++;
  }

  // Пока сообщения удерживаются неподтверждёнными, повторный get() их не отдаёт;
  // в конце возвращаем в DLQ на прежнее место.
  for (const msg of held) {
    channel.nack(msg, false, true);
  }

  return { inQueue: messageCount, processed: dryRun ? held.length : moved, orderIds };
}
