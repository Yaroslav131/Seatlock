import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  CREATE_HOLD_SCRIPT,
  CREATE_HOLD_TAKEN,
  RELEASE_HOLD_RELEASED,
  RELEASE_HOLD_SCRIPT,
} from './holds.lua';

export type CreateHoldResult =
  { type: 'HELD'; seatId: string; expiresAt: string } | { type: 'TAKEN' };

export type ReleaseHoldResult = { type: 'RELEASED' } | { type: 'NO_HOLD' };

function holdKey(eventId: string, seatId: string): string {
  return `hold:${eventId}:${seatId}`;
}
function userHoldKey(userId: string, eventId: string): string {
  return `user-hold:${userId}:${eventId}`;
}
function eventHoldsKey(eventId: string): string {
  return `event-holds:${eventId}`;
}

@Injectable()
export class HoldsService {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.ttlSeconds = Number(config.get<string>('SEAT_HOLD_TTL_SECONDS', '300'));

    // REDIS_CLIENT — синглтон на всё приложение (RedisModule @Global),
    // поэтому достаточно зарегистрировать команды один раз здесь.
    if (typeof this.redis.createHold !== 'function') {
      this.redis.defineCommand('createHold', { numberOfKeys: 3, lua: CREATE_HOLD_SCRIPT });
    }
    if (typeof this.redis.releaseHold !== 'function') {
      this.redis.defineCommand('releaseHold', { numberOfKeys: 2, lua: RELEASE_HOLD_SCRIPT });
    }
  }

  async createHold(eventId: string, seatId: string, userId: string): Promise<CreateHoldResult> {
    const now = Date.now();
    const code = await this.redis.createHold(
      holdKey(eventId, seatId),
      userHoldKey(userId, eventId),
      eventHoldsKey(eventId),
      userId,
      seatId,
      String(this.ttlSeconds),
      eventId,
      String(now),
    );

    if (code === CREATE_HOLD_TAKEN) {
      return { type: 'TAKEN' };
    }
    return {
      type: 'HELD',
      seatId,
      expiresAt: new Date(now + this.ttlSeconds * 1000).toISOString(),
    };
  }

  async releaseHold(eventId: string, userId: string): Promise<ReleaseHoldResult> {
    const code = await this.redis.releaseHold(
      userHoldKey(userId, eventId),
      eventHoldsKey(eventId),
      userId,
      eventId,
    );
    return code === RELEASE_HOLD_RELEASED ? { type: 'RELEASED' } : { type: 'NO_HOLD' };
  }

  /** ZSET самоочищается прямо на чтении — отдельный cron для протухших записей не нужен. */
  async getHeldSeats(eventId: string): Promise<string[]> {
    const key = eventHoldsKey(eventId);
    await this.redis.zremrangebyscore(key, '-inf', `(${Date.now()}`);
    return this.redis.zrange(key, 0, -1);
  }

  async getMyHold(
    eventId: string,
    userId: string,
  ): Promise<{ seatId: string; expiresAt: string } | null> {
    const seatId = await this.redis.get(userHoldKey(userId, eventId));
    if (!seatId) {
      return null;
    }
    const ttl = await this.redis.ttl(holdKey(eventId, seatId));
    if (ttl <= 0) {
      // Узкое окно: user-hold ещё не протух, а hold: — уже (независимые
      // TTL, читаем не атомарно). Следующий поллинг с фронта увидит
      // актуальное состояние — не страшно для UI с обновлением раз в ~7с.
      return null;
    }
    return { seatId, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}
