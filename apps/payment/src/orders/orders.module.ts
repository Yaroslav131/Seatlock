import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProviderModule } from '../providers/payment-provider.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SoldSeatsController } from './sold-seats.controller';

@Module({
  imports: [PaymentProviderModule, OutboxModule],
  controllers: [OrdersController, SoldSeatsController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
