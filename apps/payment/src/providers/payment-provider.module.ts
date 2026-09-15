import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakePaymentProvider } from './fake-payment.provider';
import { PAYMENT_PROVIDER } from './payment-provider.port';

/**
 * PAYMENT_PROVIDER=fake — единственное значение сейчас (задел под
 * "stripe"/"wise" позже, когда провайдер будет выбран — см. контекст
 * в docs/adr или PR-описании). Неизвестное значение — падаем на
 * старте, а не молча используем fake в проде.
 */
@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('PAYMENT_PROVIDER', 'fake');
        if (provider === 'fake') {
          return new FakePaymentProvider();
        }
        throw new Error(`Неизвестный PAYMENT_PROVIDER: "${provider}"`);
      },
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
