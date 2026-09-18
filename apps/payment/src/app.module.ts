import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { OrdersModule } from './orders/orders.module';
import { OutboxModule } from './outbox/outbox.module';
import { PrismaModule } from './prisma/prisma.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';
import { PaymentWebhookModule } from './webhooks/payment-webhook.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    ScheduleModule.forRoot(), // нужен OutboxPublisherService (@Interval)
    PrismaModule,
    RabbitmqModule,
    HealthModule,
    MetricsModule,
    OrdersModule,
    PaymentWebhookModule,
    OutboxModule,
  ],
})
export class AppModule {}
