import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

// InfraModule помечен @Global, поэтому пул Postgres и клиент Redis
// доступны здесь без явного импорта.
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
