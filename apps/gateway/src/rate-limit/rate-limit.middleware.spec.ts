import type { Request, Response } from 'express';
import { createRateLimitMiddleware } from './rate-limit.middleware';
import type { RedisRateLimiter } from './redis-rate-limiter';

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function makeReq(method: string, path: string, ip = '203.0.113.7'): Request {
  return { method, path, ip } as unknown as Request;
}

describe('rate limit middleware', () => {
  let hit: jest.Mock;
  let limiter: RedisRateLimiter;

  beforeEach(() => {
    hit = jest.fn().mockResolvedValue({ allowed: true, count: 1, retryAfterMs: 60_000 });
    limiter = { hit } as unknown as RedisRateLimiter;
  });

  function build(overrides: { enabled?: boolean; bypass?: string[] } = {}) {
    return createRateLimitMiddleware({
      limiter,
      enabled: overrides.enabled ?? true,
      bypassIps: new Set(overrides.bypass ?? []),
    });
  }

  async function run(mw: ReturnType<typeof build>, req: Request) {
    const res = makeRes();
    const next = jest.fn();
    mw(req, res as unknown as Response, next);
    // обработчики промиса выполняются на следующем тике
    await new Promise((resolve) => setImmediate(resolve));
    return { next, res };
  }

  it('политика берётся по маршруту: вход строже обычного чтения', async () => {
    const mw = build();
    await run(mw, makeReq('POST', '/api/auth/login'));
    await run(mw, makeReq('GET', '/api/catalog/events'));

    expect(hit).toHaveBeenNthCalledWith(1, 'rl:credentials:203.0.113.7', 20, 60_000);
    expect(hit).toHaveBeenNthCalledWith(2, 'rl:default:203.0.113.7', 600, 60_000);
  });

  it('путь вне таблицы (seat-status, /api/me) считается обычным чтением', async () => {
    await run(build(), makeReq('GET', '/api/events/e1/seat-status'));
    expect(hit).toHaveBeenCalledWith('rl:default:203.0.113.7', 600, 60_000);
  });

  it('вебхук платёжного провайдера не ограничивается вовсе', async () => {
    const { next } = await run(build(), makeReq('POST', '/api/payment/webhooks/provider'));
    expect(hit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['выключен', { enabled: false }, '/api/catalog/events'],
    ['адрес в списке обхода', { bypass: ['203.0.113.7'] }, '/api/catalog/events'],
    ['путь вне /api (health, metrics)', {}, '/health'],
  ])('%s — Redis не трогаем', async (_name, overrides, path) => {
    const { next } = await run(build(overrides), makeReq('GET', path));
    expect(hit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('лимит превышен — 429 с Retry-After и без next()', async () => {
    hit.mockResolvedValue({ allowed: false, count: 11, retryAfterMs: 42_100 });
    const { next, res } = await run(build(), makeReq('POST', '/api/auth/login'));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '43');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 429 }));
  });

  it('Redis недоступен — запрос пропускается ровно один раз (fail-open)', async () => {
    hit.mockRejectedValue(new Error('Redis не ответил за 100 мс'));
    const { next, res } = await run(build(), makeReq('GET', '/api/catalog/events'));

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
