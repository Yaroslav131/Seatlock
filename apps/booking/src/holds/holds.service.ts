import { Inject, Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(HoldsService.name);
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

  /**
   * ZSET — вторичный индекс для дешёвого листинга, а не источник истины
   * (источник истины — ключи hold:{eventId}:{seatId}). По времени
   * самоочищается через ZREMRANGEBYSCORE, но на проде реально поймано
   * место, застрявшее в индексе как занятое при пустом user-hold —
   * точный триггер (какая именно гонка параллельных запросов от одного
   * юзера к этому привела) не локализован до конца, но сам симптом
   * подтверждён напрямую через curl на живых данных на проде.
   * Раз индекс — это просто кэш поверх первичных ключей, читаем его
   * осторожно: сверяем каждую запись с реальным hold:-ключом через
   * MGET и чистим "осиротевшие" записи прямо на чтении, а не доверяем
   * индексу слепо — это делает систему самовосстанавливающейся
   * независимо от того, как именно возникло расхождение.
   */
  async getHeldSeats(eventId: string): Promise<string[]> {
    const key = eventHoldsKey(eventId);
    await this.redis.zremrangebyscore(key, '-inf', `(${Date.now()}`);
    const seatIds = await this.redis.zrange(key, 0, -1);
    if (seatIds.length === 0) {
      return [];
    }

    const holdKeys = seatIds.map((seatId) => holdKey(eventId, seatId));
    const holders = await this.redis.mget(...holdKeys);

    const confirmed: string[] = [];
    const orphaned: string[] = [];
    seatIds.forEach((seatId, i) => {
      if (holders[i]) {
        confirmed.push(seatId);
      } else {
        orphaned.push(seatId);
      }
    });

    if (orphaned.length > 0) {
      this.logger.warn(
        `getHeldSeats: осиротевшие записи индекса для eventId=${eventId}: [${orphaned.join(', ')}] — чищу через zrem`,
      );
      await this.redis.zrem(key, ...orphaned);
    }

    return confirmed;
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
      this.logger.warn(
        `getMyHold: user-hold указывает на seatId=${seatId} для userId=${userId} eventId=${eventId}, но hold:-ключ уже протух (ttl=${ttl}) — отдаю null`,
      );
      return null;
    }
    return { seatId, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}
