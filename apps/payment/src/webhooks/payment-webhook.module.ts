import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PaymentProviderModule } from '../providers/payment-provider.module';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';

@Module({
  imports: [PaymentProviderModule, OutboxModule],
  controllers: [PaymentWebhookController],
  providers: [PaymentWebhookService],
})
export class PaymentWebhookModule {}
