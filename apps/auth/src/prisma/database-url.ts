// По умолчанию Prisma берёт размер пула «число CPU × 2 + 1», причём число CPU считает у
// хозяйской машины, а не по лимитам контейнера. На проде (2 vCPU) это 5 соединений, а на
// машине с 16 ядрами (Docker Desktop, kind, большой узел Kubernetes) уже 22, и четыре
// сервиса в двух репликах легко выбирают все 100 соединений Postgres (max_connections).
// Поэтому размер задаётся явно: одинаково везде и независимо от железа.
const DEFAULT_POOL_SIZE = 5;
const MAX_POOL_SIZE = 50;

// Сколько запрос ждёт свободного соединения из пула, секунд (по умолчанию у Prisma тоже 10).
// Дольше ждать нет смысла: gateway обрывает запрос через 15 с, и клиент уже ушёл бы.
const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

/**
 * Размер пула из DB_POOL_SIZE. Неверное значение — ошибка на старте, а не тихий откат к
 * умолчанию: опечатка в конфиге иначе осталась бы незамеченной.
 */
export function readPoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_POOL_SIZE;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_POOL_SIZE) {
    throw new Error(
      `DB_POOL_SIZE должен быть целым числом от 1 до ${MAX_POOL_SIZE}, получено: ${raw}`,
    );
  }
  return value;
}

/**
 * Дописывает в адрес базы размер пула и время ожидания соединения. Если они уже указаны
 * в самом адресе (`?connection_limit=...`), то остаются как есть: явная настройка
 * конкретного развёртывания важнее общего умолчания.
 */
export function withPoolSettings(rawUrl: string, poolSize: number): string {
  const url = new URL(rawUrl);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(poolSize));
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', String(DEFAULT_POOL_TIMEOUT_SECONDS));
  }
  return url.toString();
}

/** Параметры PrismaClient: адрес из переменной окружения с настроенным пулом. */
export function prismaOptions(rawUrl: string | undefined): { datasourceUrl: string } | undefined {
  if (!rawUrl) {
    // Адрес не задан: пусть PrismaClient сам сообщит об этом при подключении.
    return undefined;
  }
  return { datasourceUrl: withPoolSettings(rawUrl, readPoolSize(process.env.DB_POOL_SIZE)) };
}
