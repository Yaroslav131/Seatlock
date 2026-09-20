import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakePaymentProvider } from './fake-payment.provider';
import { PaymentProviderPort, PAYMENT_PROVIDER } from './payment-provider.port';

/**
 * PAYMENT_PROVIDER=fake — единственное значение сейчас (задел под
 * "stripe"/"wise" позже, когда провайдер будет выбран — см. контекст
 * в docs/adr или PR-описании). Неизвестное значение — падаем на
 * старте, а не молча используем fake в проде.
 *
 * fake в production — это демо-режим: подпись вебхука не проверяется, деньги
 * не списываются. Чтобы он не "доехал" до реальных денег случайно (новый
 * сервер, копия конфига без осознанного решения), в production он включается
 * только явным ALLOW_FAKE_PAYMENTS=true (см. docs/adr/0004).
 */
export function createPaymentProvider(
  env: { provider: string; nodeEnv?: string; allowFake?: string },
  logger: Pick<Logger, 'warn'> = new Logger('PaymentProvider'),
): PaymentProviderPort {
  if (env.provider !== 'fake') {
    throw new Error(`Неизвестный PAYMENT_PROVIDER: "${env.provider}"`);
  }

  if (env.nodeEnv === 'production') {
    if (env.allowFake !== 'true') {
      throw new Error(
        'PAYMENT_PROVIDER=fake в production: оплата не проверяется, деньги не списываются. ' +
          'Если это осознанный демо-режим, задайте ALLOW_FAKE_PAYMENTS=true; ' +
          'для приёма настоящих платежей подключите реального провайдера.',
      );
    }
    logger.warn('демо-режим оплаты (fake) включён в production: деньги не списываются');
  }

  return new FakePaymentProvider();
}

@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PaymentProviderPort =>
        createPaymentProvider({
          provider: config.get<string>('PAYMENT_PROVIDER', 'fake'),
          nodeEnv: config.get<string>('NODE_ENV'),
          allowFake: config.get<string>('ALLOW_FAKE_PAYMENTS'),
        }),
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
