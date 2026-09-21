import type Redis from 'ioredis';
import { RedisRateLimiter } from './redis-rate-limiter';

function limiterWith(evalImpl: () => Promise<unknown>): RedisRateLimiter {
  return new RedisRateLimiter({ eval: jest.fn(evalImpl) } as unknown as Redis);
}

describe('RedisRateLimiter', () => {
  it('в пределах лимита — allowed, на границе включительно', async () => {
    expect(await limiterWith(() => Promise.resolve([10, 30_000])).hit('k', 10, 60_000)).toEqual({
      allowed: true,
      count: 10,
      retryAfterMs: 30_000,
    });
  });

  it('сверх лимита — не allowed, retryAfter из оставшегося TTL окна', async () => {
    const result = await limiterWith(() => Promise.resolve([11, 12_000])).hit('k', 10, 60_000);
    expect(result).toEqual({ allowed: false, count: 11, retryAfterMs: 12_000 });
  });

  it('TTL не вернулся (-1) — retryAfter равен целому окну', async () => {
    const result = await limiterWith(() => Promise.resolve([11, -1])).hit('k', 10, 60_000);
    expect(result.retryAfterMs).toBe(60_000);
  });

  it('Redis молчит дольше 100 мс — ошибка (вызывающий пропустит запрос)', async () => {
    const never = () => new Promise<never>(() => undefined);
    await expect(limiterWith(never).hit('k', 10, 60_000)).rejects.toThrow('Redis не ответил');
  });
});
