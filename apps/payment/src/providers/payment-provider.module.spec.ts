import { createPaymentProvider } from './payment-provider.module';
import { FakePaymentProvider } from './fake-payment.provider';

describe('createPaymentProvider', () => {
  const logger = { warn: jest.fn() };

  beforeEach(() => logger.warn.mockReset());

  it('fake в development и test — без ограничений и без предупреждения', () => {
    expect(
      createPaymentProvider({ provider: 'fake', nodeEnv: 'development' }, logger),
    ).toBeInstanceOf(FakePaymentProvider);
    expect(createPaymentProvider({ provider: 'fake', nodeEnv: 'test' }, logger)).toBeInstanceOf(
      FakePaymentProvider,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fake в production без ALLOW_FAKE_PAYMENTS — сервис не стартует', () => {
    expect(() =>
      createPaymentProvider({ provider: 'fake', nodeEnv: 'production' }, logger),
    ).toThrow(/ALLOW_FAKE_PAYMENTS=true/);
    expect(() =>
      createPaymentProvider({ provider: 'fake', nodeEnv: 'production', allowFake: 'yes' }, logger),
    ).toThrow(/ALLOW_FAKE_PAYMENTS=true/);
  });

  it('fake в production с ALLOW_FAKE_PAYMENTS=true — стартует и пишет предупреждение', () => {
    const provider = createPaymentProvider(
      { provider: 'fake', nodeEnv: 'production', allowFake: 'true' },
      logger,
    );

    expect(provider).toBeInstanceOf(FakePaymentProvider);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('неизвестный провайдер — ошибка независимо от окружения', () => {
    expect(() =>
      createPaymentProvider({ provider: 'stripe', nodeEnv: 'development' }, logger),
    ).toThrow(/Неизвестный PAYMENT_PROVIDER/);
  });
});
