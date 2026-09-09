import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis(config.getOrThrow<string>('REDIS_URL'), {
          maxRetriesPerRequest: 2,
          retryStrategy: (times) => Math.min(times * 200, 2_000),
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Без этого на SIGTERM/app.close() TCP-соединение с Redis не
   * закрывается корректно — просто обрывается ОС, теряя то, что ещё
   * не успело уйти по конвейеру.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`остановка (${signal ?? 'вручную'}) — закрываю redis`);
    const redis = this.moduleRef.get<Redis>(REDIS_CLIENT);
    await redis.quit();
  }
}
