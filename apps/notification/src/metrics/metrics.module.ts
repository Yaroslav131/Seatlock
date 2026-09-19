import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { collectDefaultMetrics } from 'prom-client';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { QueueDepthMetric } from './queue-depth.metric';

// Память/event loop lag/GC — без единой строчки кода сверху, сама
// библиотека уже знает, что и как собирать.
collectDefaultMetrics();

@Module({
  controllers: [MetricsController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }, QueueDepthMetric],
})
export class MetricsModule {}
