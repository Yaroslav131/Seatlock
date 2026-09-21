import { ConfigService } from '@nestjs/config';

const DEFAULT_PREFETCH = 1;
const MAX_PREFETCH = 50;

/**
 * Сколько сообщений consumer держит в работе одновременно (NOTIFICATION_PREFETCH).
 * Параллельная обработка безопасна: заказ захватывается атомарно (см.
 * order-paid.consumer.ts, claim()), два сообщения одного заказа письмо дважды не отправят.
 * Неверное значение — ошибка на старте, а не тихий откат к 1: иначе опечатка в
 * конфиге незаметно оставит сервис на прежней пропускной способности.
 */
export function readPrefetch(config: ConfigService): number {
  const raw = config.get<string | number>('NOTIFICATION_PREFETCH');
  if (raw === undefined || raw === '') {
    return DEFAULT_PREFETCH;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PREFETCH) {
    throw new Error(
      `NOTIFICATION_PREFETCH должен быть целым числом от 1 до ${MAX_PREFETCH}, получено: ${String(raw)}`,
    );
  }
  return value;
}
