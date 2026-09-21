import type * as amqp from 'amqplib';
import { replayDeadLetters } from './replay-dead-letters';
import { NOTIFICATION_DLQ, ORDER_PAID_QUEUE } from '../rabbitmq/rabbitmq.module';

function dlqMessage(payload: unknown): amqp.GetMessage {
  const content = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: Buffer.from(content) } as unknown as amqp.GetMessage;
}

function createChannel(messages: amqp.GetMessage[]) {
  const queue = [...messages];
  return {
    checkQueue: jest.fn((name: string) =>
      Promise.resolve({ queue: name, messageCount: name === NOTIFICATION_DLQ ? queue.length : 0 }),
    ),
    get: jest.fn(() => Promise.resolve(queue.shift() ?? false)),
    sendToQueue: jest.fn(
      (_queue: string, _content: Buffer, _options: unknown, cb: (err: unknown) => void) => {
        cb(null);
        return true;
      },
    ),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('replayDeadLetters', () => {
  it('переносит сообщения из DLQ в очередь notification, подтверждая их только после публикации', async () => {
    const a = dlqMessage({ orderId: 'order-a' });
    const b = dlqMessage({ orderId: 'order-b' });
    const channel = createChannel([a, b]);

    const result = await replayDeadLetters(channel as unknown as amqp.ConfirmChannel, {
      limit: 10,
      dryRun: false,
    });

    expect(result).toEqual({ inQueue: 2, processed: 2, orderIds: ['order-a', 'order-b'] });
    expect(channel.sendToQueue).toHaveBeenCalledTimes(2);
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      ORDER_PAID_QUEUE,
      a.content,
      expect.objectContaining({ persistent: true }),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledTimes(2);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('не подтверждает сообщение в DLQ, если публикация не удалась', async () => {
    const channel = createChannel([dlqMessage({ orderId: 'order-a' })]);
    channel.sendToQueue.mockImplementation((_q, _c, _o, cb) => {
      cb(new Error('брокер не подтвердил'));
      return true;
    });

    await expect(
      replayDeadLetters(channel as unknown as amqp.ConfirmChannel, { limit: 10, dryRun: false }),
    ).rejects.toThrow('брокер не подтвердил');
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('уважает limit', async () => {
    const channel = createChannel([
      dlqMessage({ orderId: '1' }),
      dlqMessage({ orderId: '2' }),
      dlqMessage({ orderId: '3' }),
    ]);

    const result = await replayDeadLetters(channel as unknown as amqp.ConfirmChannel, {
      limit: 2,
      dryRun: false,
    });

    expect(result.processed).toBe(2);
    expect(result.inQueue).toBe(3);
    expect(channel.get).toHaveBeenCalledTimes(2);
  });

  it('dry-run: ничего не переносит и возвращает прочитанные сообщения обратно', async () => {
    const a = dlqMessage({ orderId: 'order-a' });
    const channel = createChannel([a]);

    const result = await replayDeadLetters(channel as unknown as amqp.ConfirmChannel, {
      limit: 10,
      dryRun: true,
    });

    expect(result).toEqual({ inQueue: 1, processed: 1, orderIds: ['order-a'] });
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(a, false, true);
  });

  it('пустая DLQ и нечитаемое сообщение не роняют перенос', async () => {
    const empty = await replayDeadLetters(createChannel([]) as unknown as amqp.ConfirmChannel, {
      limit: 10,
      dryRun: false,
    });
    expect(empty.processed).toBe(0);

    const garbage = await replayDeadLetters(
      createChannel([dlqMessage('не json')]) as unknown as amqp.ConfirmChannel,
      { limit: 10, dryRun: false },
    );
    expect(garbage.orderIds).toEqual(['(нечитаемое сообщение)']);
    expect(garbage.processed).toBe(1);
  });
});
