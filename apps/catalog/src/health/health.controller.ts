import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../cache/redis.module';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string; service: string }> {
    try {
      await Promise.all([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);
      return { status: 'ok', service: 'catalog' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException({
        status: 'error',
        service: 'catalog',
        error: message,
      });
    }
  }
}
