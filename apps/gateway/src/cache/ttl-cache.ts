export type CacheSource = 'hit' | 'miss' | 'coalesced';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Маленький кеш с временем жизни и объединением одинаковых запросов (single-flight).
 *
 * Объединение важнее самого кеша: когда тысяча зрителей смотрит одно и то же
 * событие, а запись только что протухла, в сервис уходит один запрос, остальные
 * ждут его результат (без этого протухание порождало бы лавину одинаковых запросов).
 *
 * Хранится в памяти процесса: у каждой реплики gateway свой кеш, и для публичных
 * данных с коротким TTL этого достаточно (общий кеш потребовал бы похода в Redis,
 * который стоит почти как сам поход в сервис).
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * @param loader сходить за значением; `cacheable: false` — отдать, но не запоминать
   * (ошибки и неполные ответы кешировать нельзя).
   */
  async get(
    key: string,
    ttlMs: number,
    loader: () => Promise<{ value: T; cacheable: boolean }>,
  ): Promise<{ value: T; source: CacheSource }> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return { value: cached.value, source: 'hit' };
    }

    const running = this.inflight.get(key);
    if (running) {
      return { value: await running, source: 'coalesced' };
    }

    const promise = loader().then(({ value, cacheable }) => {
      if (cacheable) {
        this.store(key, value, ttlMs);
      }
      return value;
    });
    this.inflight.set(key, promise);
    try {
      return { value: await promise, source: 'miss' };
    } finally {
      this.inflight.delete(key);
    }
  }

  private store(key: string, value: T, ttlMs: number): void {
    // Повторная вставка перемещает ключ в конец порядка Map — так самые старые
    // записи остаются в начале и вытесняются первыми.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.entries.size > this.maxEntries) {
      this.evict();
    }
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    // Если протухших не нашлось, а место нужно, вытесняем самые старые.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) {
        break;
      }
      this.entries.delete(key);
    }
  }

  /** Забыть значение: следующий get() сходит за свежим. Идущий запрос не прерывается. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
