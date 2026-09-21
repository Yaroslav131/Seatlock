import type Redis from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterMs: number;
}

// Атомарно: увеличить счётчик и при первом обращении назначить время жизни окна.
// Отдельные INCR и PEXPIRE могли бы оставить счётчик без TTL, если процесс упадёт
// между ними, и IP был бы заблокирован навсегда.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

// Дольше проверка не ждёт: лимит не должен делать все запросы медленными, когда Redis тормозит.
const CHECK_TIMEOUT_MS = 100;

/**
 * Счётчик «не больше N запросов за окно» на Redis, общий для всех реплик gateway.
 * Окно фиксированное, начинается с первого запроса: на стыке окон возможен всплеск
 * до 2N, для защиты от перебора и грубых перегрузок это приемлемо и стоит одного
 * вызова Redis на запрос.
 *
 * Если Redis недоступен или не ответил за 100 мс, запрос пропускается (fail-open),
 * а ошибка возвращается вызывающему для метрики. Лимит защищает сервис,
 * и падение Redis не должно превращаться в падение всего сайта.
 */
export class RedisRateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const result = (await withTimeout(
      this.redis.eval(HIT_SCRIPT, 1, key, String(windowMs)),
      CHECK_TIMEOUT_MS,
    )) as [number, number];
    const [count, ttl] = result;
    return {
      allowed: count <= limit,
      count,
      retryAfterMs: ttl > 0 ? ttl : windowMs,
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis не ответил за ${ms} мс`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
