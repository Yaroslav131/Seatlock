import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { POSTGRES_POOL, REDIS_CLIENT } from '../infra/tokens';

/** Результат проверки одной зависимости. */
export interface DependencyCheck {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

/** Общий отчёт о готовности сервиса. */
export interface HealthReport {
  status: 'ok' | 'error';
  service: string;
  uptimeSec: number;
  checks: Record<string, DependencyCheck>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Опрашивает все зависимости параллельно.
   * Сервис считается готовым, только если поднялись вообще все.
   */
  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    const checks: Record<string, DependencyCheck> = { postgres, redis };
    const healthy = Object.values(checks).every((check) => check.status === 'up');

    return {
      status: healthy ? 'ok' : 'error',
      service: 'gateway',
      uptimeSec: Math.round(process.uptime()),
      checks,
    };
  }

  /**
   * Обёртка вокруг проверки: меряет время и превращает любое исключение
   * в статус down. Health-эндпоинт не имеет права падать сам —
   * иначе балансировщик не отличит «база лежит» от «сервис сломан».
   */
  private async measure(name: string, probe: () => Promise<unknown>): Promise<DependencyCheck> {
    const startedAt = Date.now();
    try {
      await probe();
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`проверка "${name}" не прошла: ${message}`);
      return { status: 'down', latencyMs: Date.now() - startedAt, error: message };
    }
  }

  private checkPostgres(): Promise<DependencyCheck> {
    return this.measure('postgres', () => this.pool.query('select 1'));
  }

  private checkRedis(): Promise<DependencyCheck> {
    return this.measure('redis', () => this.redis.ping());
  }
}
