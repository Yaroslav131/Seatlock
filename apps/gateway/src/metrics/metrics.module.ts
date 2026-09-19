import { Module } from '@nestjs/common';
import { collectDefaultMetrics } from 'prom-client';
import { MetricsController } from './metrics.controller';

// Память/event loop lag/GC — без единой строчки кода сверху, сама
// библиотека уже знает, что и как собирать. Именно здесь, а не в
// metrics.ts (там только middleware для http_requests_total/duration —
// её main.ts подключает отдельно, см. комментарий там), потому что
// MetricsModule гарантированно инициализируется в любом NestJS-контексте
// приложения, включая тесты (Test.createTestingModule), которые
// main.ts целиком не запускают.
collectDefaultMetrics();

@Module({
  controllers: [MetricsController],
})
export class MetricsModule {}
