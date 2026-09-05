import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { POSTGRES_POOL, REDIS_CLIENT } from './tokens';

/**
 * Подключения к внешним хранилищам.
 *
 * Модуль помечен @Global, потому что пул Postgres и клиент Redis нужны
 * почти везде, и таскать импорт InfraModule в каждый модуль — только шум.
 */
@Global()
@Module({
  providers: [
    {
      provide: POSTGRES_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          // getOrThrow, а не get: если DATABASE_URL забыли — сервис
          // должен упасть на старте, а не через час на первом запросе.
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 10,
          connectionTimeoutMillis: 3_000,
        }),
    },
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          // Ограничиваем ретраи: health-check должен быстро сказать
          // «redis лежит», а не висеть, переподключаясь до бесконечности.
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        }),
    },
  ],
  exports: [POSTGRES_POOL, REDIS_CLIENT],
})
export class InfraModule implements OnApplicationShutdown {
  private readonly logger = new Logger(InfraModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Корректное завершение: закрываем соединения, чтобы Postgres и Redis
   * не копили висящие сессии при каждом перезапуске контейнера.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`остановка (${signal ?? 'вручную'}) — закрываю postgres и redis`);
    const pool = this.moduleRef.get<Pool>(POSTGRES_POOL);
    const redis = this.moduleRef.get<Redis>(REDIS_CLIENT);
    // allSettled: если одно соединение уже мертво, второе всё равно закроем.
    await Promise.allSettled([pool.end(), redis.quit()]);
  }
}
