import * as amqp from 'amqplib';
import { replayDeadLetters } from '../dlq/replay-dead-letters';

// Ручной запуск оператором (внутри контейнера notification):
//   node dist/scripts/replay-dlq.js --dry-run       — показать, что лежит в DLQ
//   node dist/scripts/replay-dlq.js --limit=50      — вернуть до 50 сообщений в работу
// Сначала почините причину сбоя (см. errorMessage в notification_logs), иначе
// сообщения снова окажутся в DLQ.

const DEFAULT_LIMIT = 100;

function parseArgs(argv: string[]): { limit: number; dryRun: boolean } {
  const dryRun = argv.includes('--dry-run');
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit должен быть целым числом больше нуля, получено: ${limitArg}`);
  }
  return { limit, dryRun };
}

async function main(): Promise<void> {
  const { limit, dryRun } = parseArgs(process.argv.slice(2));
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    throw new Error('не задана переменная RABBITMQ_URL');
  }

  const connection = await amqp.connect(url);
  try {
    const channel = await connection.createConfirmChannel();
    const result = await replayDeadLetters(channel, { limit, dryRun });
    await channel.close();

    const action = dryRun ? 'просмотрено (ничего не перенесено)' : 'возвращено в работу';
    process.stdout.write(
      `в DLQ было: ${result.inQueue}, ${action}: ${result.processed}\n` +
        result.orderIds.map((id) => `  заказ ${id}\n`).join(''),
    );
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`ошибка: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
