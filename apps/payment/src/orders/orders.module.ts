import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProviderModule } from '../providers/payment-provider.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PaymentProviderModule, OutboxModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
