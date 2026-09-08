import Redis from 'ioredis';
import { HoldsService } from './holds.service';

/**
 * Единственный тест в проекте, который бьёт в настоящий Redis, а не мок —
 * сознательно: сама бизнес-логика (атомарный перенос холда, отказ при
 * гонке за одно место, TTL) живёт ВНУТРИ Lua-скрипта (holds.lua.ts), а
 * не в HoldsService — мок redis.eval может проверить только то, что мы
 * сами ему скажем вернуть, и никогда не поймает баг в самом скрипте.
 *
 * REDIS_URL по умолчанию — локальный дев-порт из docker-compose.yml
 * (pnpm infra:up). В CI .github/workflows/ci.yml переопределяет его на
 * сервис-контейнер redis:7-alpine. db:15 — отдельная логическая БД,
 * чтобы flushdb() в beforeEach не задел чужие данные, если кто-то
 * случайно погонит тест против дев-инстанса с реальными данными.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

describe('holds Lua-скрипты (реальный Redis)', () => {
  jest.setTimeout(20_000);

  let redis: Redis;
  let service: HoldsService;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { db: 15, maxRetriesPerRequest: 1 });
    service = new HoldsService(redis, { get: () => '5' } as never);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it('два юзера держат два разных места одного события — оба успешны', async () => {
    const r1 = await service.createHold('event-1', 'seat-A', 'user-1');
    const r2 = await service.createHold('event-1', 'seat-B', 'user-2');

    expect(r1.type).toBe('HELD');
    expect(r2.type).toBe('HELD');
    expect(await service.getHeldSeats('event-1')).toEqual(
      expect.arrayContaining(['seat-A', 'seat-B']),
    );
  });

  it('второй юзер не может занять уже занятое место', async () => {
    await service.createHold('event-1', 'seat-A', 'user-1');
    const result = await service.createHold('event-1', 'seat-A', 'user-2');

    expect(result).toEqual({ type: 'TAKEN' });
    expect(await service.getHeldSeats('event-1')).toEqual(['seat-A']);
  });

  it('перенос холда на новое место освобождает старое (один холд на юзера в событии)', async () => {
    await service.createHold('event-1', 'seat-A', 'user-1');
    const moved = await service.createHold('event-1', 'seat-B', 'user-1');

    expect(moved.type).toBe('HELD');
    expect(await service.getHeldSeats('event-1')).toEqual(['seat-B']);

    // старое место теперь реально свободно — другой юзер может его занять
    const takenByOther = await service.createHold('event-1', 'seat-A', 'user-2');
    expect(takenByOther.type).toBe('HELD');
  });

  it('повторный holdSeat на своё же место продлевает TTL, а не отклоняется', async () => {
    await service.createHold('event-1', 'seat-A', 'user-1');
    const ttlBefore = await redis.ttl('hold:event-1:seat-A');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await service.createHold('event-1', 'seat-A', 'user-1');
    const ttlAfter = await redis.ttl('hold:event-1:seat-A');

    expect(again.type).toBe('HELD');
    expect(ttlAfter).toBeGreaterThanOrEqual(ttlBefore);
    expect(await service.getHeldSeats('event-1')).toEqual(['seat-A']);
  });

  it('releaseHold без активного холда — no-op, ничего не ломает', async () => {
    const result = await service.releaseHold('event-1', 'user-1');
    expect(result).toEqual({ type: 'NO_HOLD' });
  });

  it('releaseHold освобождает место — его сразу может занять другой юзер', async () => {
    await service.createHold('event-1', 'seat-A', 'user-1');
    const released = await service.releaseHold('event-1', 'user-1');
    expect(released).toEqual({ type: 'RELEASED' });

    expect(await service.getHeldSeats('event-1')).toEqual([]);
    const takenByOther = await service.createHold('event-1', 'seat-A', 'user-2');
    expect(takenByOther.type).toBe('HELD');
  });

  it('истечение холда одного юзера не трогает независимый холд другого', async () => {
    // короткий TTL только для этого сценария — своя ConfigService-заглушка
    const shortTtlService = new HoldsService(redis, { get: () => '1' } as never);

    await shortTtlService.createHold('event-1', 'seat-A', 'user-1');
    const other = await service.createHold('event-1', 'seat-B', 'user-2');
    expect(other.type).toBe('HELD');

    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(await service.getHeldSeats('event-1')).toEqual(['seat-B']);
    expect(await service.getMyHold('event-1', 'user-2')).not.toBeNull();
  });

  it('самолечится, если ZSET-индекс разошёлся с первичным hold-ключом (поймано на проде)', async () => {
    // Имитируем ровно то расхождение, что реально обнаружено на проде:
    // место числится занятым в индексе, но первичного hold:-ключа для
    // него уже нет — то есть holdSeat/releaseHold тут ни при чём, сама
    // запись индекса "осиротела" каким-то ещё не до конца локализованным
    // путём. Пишем это состояние в Redis напрямую, в обход HoldsService.
    await redis.zadd('event-holds:event-1', Date.now() + 60_000, 'orphaned-seat');
    await service.createHold('event-1', 'seat-A', 'user-1');

    const held = await service.getHeldSeats('event-1');

    expect(held).toEqual(['seat-A']);
    expect(await redis.zscore('event-holds:event-1', 'orphaned-seat')).toBeNull();
  });
});
