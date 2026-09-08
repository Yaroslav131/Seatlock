import { ConfigService } from '@nestjs/config';
import {
  CREATE_HOLD_OK,
  CREATE_HOLD_TAKEN,
  RELEASE_HOLD_NO_HOLD,
  RELEASE_HOLD_RELEASED,
} from './holds.lua';
import { HoldsService } from './holds.service';

function createRedisMock() {
  return {
    createHold: jest.fn(),
    releaseHold: jest.fn(),
    defineCommand: jest.fn(),
    get: jest.fn(),
    ttl: jest.fn(),
    zrange: jest.fn(),
    zremrangebyscore: jest.fn(),
    mget: jest.fn(),
    zrem: jest.fn(),
  };
}

function createConfigMock(ttl = '300') {
  return { get: jest.fn().mockReturnValue(ttl) };
}

type RedisMock = ReturnType<typeof createRedisMock>;

// Эти тесты проверяют только TS-обёртку вокруг Lua-скриптов: правильные
// аргументы уходят в redis.eval-обёртку и правильно декодируется код
// возврата. Саму атомарность скриптов (гонки, перенос холда, TTL) они
// НЕ проверяют — для этого есть holds.lua.integration.spec.ts с настоящим
// Redis, потому что бизнес-логика живёт внутри самой Lua-строки, а не
// здесь — мок createHold/releaseHold просто возвращает то число, которое
// мы ему скажем, вне зависимости от того, что было бы на реальном сервере.
describe('HoldsService', () => {
  let redis: RedisMock;
  let service: HoldsService;

  beforeEach(() => {
    redis = createRedisMock();
    service = new HoldsService(redis as never, createConfigMock() as unknown as ConfigService);
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createHold', () => {
    it('возвращает HELD с рассчитанным expiresAt при коде OK', async () => {
      redis.createHold.mockResolvedValue(CREATE_HOLD_OK);

      const result = await service.createHold('event-1', 'seat-1', 'user-1');

      expect(result).toEqual({
        type: 'HELD',
        seatId: 'seat-1',
        expiresAt: new Date(1_000_000 + 300 * 1000).toISOString(),
      });
    });

    it('возвращает TAKEN при коде TAKEN, не выдумывая expiresAt', async () => {
      redis.createHold.mockResolvedValue(CREATE_HOLD_TAKEN);

      const result = await service.createHold('event-1', 'seat-1', 'user-1');

      expect(result).toEqual({ type: 'TAKEN' });
    });

    it('зовёт redis.createHold с ключами и аргументами в правильном порядке', async () => {
      redis.createHold.mockResolvedValue(CREATE_HOLD_OK);

      await service.createHold('event-1', 'seat-1', 'user-1');

      expect(redis.createHold).toHaveBeenCalledWith(
        'hold:event-1:seat-1',
        'user-hold:user-1:event-1',
        'event-holds:event-1',
        'user-1',
        'seat-1',
        '300',
        'event-1',
        '1000000',
      );
    });
  });

  describe('releaseHold', () => {
    it('возвращает RELEASED при коде RELEASED', async () => {
      redis.releaseHold.mockResolvedValue(RELEASE_HOLD_RELEASED);
      await expect(service.releaseHold('event-1', 'user-1')).resolves.toEqual({ type: 'RELEASED' });
    });

    it('возвращает NO_HOLD при коде NO_HOLD', async () => {
      redis.releaseHold.mockResolvedValue(RELEASE_HOLD_NO_HOLD);
      await expect(service.releaseHold('event-1', 'user-1')).resolves.toEqual({ type: 'NO_HOLD' });
    });
  });

  describe('getHeldSeats', () => {
    it('сначала чистит протухшие по времени записи, потом читает список', async () => {
      redis.zrange.mockResolvedValue(['seat-1', 'seat-2']);
      redis.mget.mockResolvedValue(['user-1', 'user-2']);

      const seats = await service.getHeldSeats('event-1');

      expect(redis.zremrangebyscore).toHaveBeenCalledWith(
        'event-holds:event-1',
        '-inf',
        '(1000000',
      );
      expect(redis.zrange).toHaveBeenCalledWith('event-holds:event-1', 0, -1);
      expect(seats).toEqual(['seat-1', 'seat-2']);
    });

    it('не ходит в mget/zrem, если индекс и так пуст', async () => {
      redis.zrange.mockResolvedValue([]);

      const seats = await service.getHeldSeats('event-1');

      expect(redis.mget).not.toHaveBeenCalled();
      expect(seats).toEqual([]);
    });

    it('сверяет каждую запись индекса с реальным hold-ключом через mget', async () => {
      redis.zrange.mockResolvedValue(['seat-1', 'seat-2']);
      redis.mget.mockResolvedValue(['user-1', 'user-2']);

      await service.getHeldSeats('event-1');

      expect(redis.mget).toHaveBeenCalledWith('hold:event-1:seat-1', 'hold:event-1:seat-2');
    });

    it('вычищает из индекса "осиротевшие" места без реального hold-ключа и не отдаёт их наружу', async () => {
      redis.zrange.mockResolvedValue(['seat-1', 'seat-2', 'seat-3']);
      // seat-2 есть в индексе, но первичного hold:-ключа для него уже нет — "осиротело".
      redis.mget.mockResolvedValue(['user-1', null, 'user-3']);

      const seats = await service.getHeldSeats('event-1');

      expect(seats).toEqual(['seat-1', 'seat-3']);
      expect(redis.zrem).toHaveBeenCalledWith('event-holds:event-1', 'seat-2');
    });

    it('не зовёт zrem, если осиротевших записей не нашлось', async () => {
      redis.zrange.mockResolvedValue(['seat-1']);
      redis.mget.mockResolvedValue(['user-1']);

      await service.getHeldSeats('event-1');

      expect(redis.zrem).not.toHaveBeenCalled();
    });
  });

  describe('getMyHold', () => {
    it('возвращает null, если у юзера нет активного холда', async () => {
      redis.get.mockResolvedValue(null);

      const hold = await service.getMyHold('event-1', 'user-1');

      expect(hold).toBeNull();
      expect(redis.ttl).not.toHaveBeenCalled();
    });

    it('возвращает null при протухшем hold-ключе, несмотря на живой user-hold', async () => {
      redis.get.mockResolvedValue('seat-1');
      redis.ttl.mockResolvedValue(0);

      const hold = await service.getMyHold('event-1', 'user-1');

      expect(hold).toBeNull();
    });

    it('возвращает seatId и expiresAt, рассчитанный из TTL', async () => {
      redis.get.mockResolvedValue('seat-1');
      redis.ttl.mockResolvedValue(120);

      const hold = await service.getMyHold('event-1', 'user-1');

      expect(hold).toEqual({
        seatId: 'seat-1',
        expiresAt: new Date(1_000_000 + 120 * 1000).toISOString(),
      });
    });
  });
});
