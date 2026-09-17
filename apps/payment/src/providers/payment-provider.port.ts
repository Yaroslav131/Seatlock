/**
 * Абстракция платёжного провайдера. Выбор конкретного (Stripe/Wise/...)
 * сознательно отложен — из Беларуси Stripe недоступен (санкции), а
 * альтернатива ещё не выбрана. Сага/вебхуки/outbox не должны ждать
 * этого решения: реализация ниже (FakePaymentProvider) даёт полностью
 * рабочий и тестируемый цикл заказа уже сейчас. Подключение реального
 * провайдера позже — это только новый класс за этим же интерфейсом,
 * без изменений в orders.service.ts/payment-webhook.service.ts.
 */
export interface PaymentProviderPort {
  createPaymentIntent(params: {
    amountCents: number;
    currency: string;
    metadata: Record<string, string>;
  }): Promise<{ providerIntentId: string; clientSecret: string }>;

  /** null — подпись не совпала (или тело не распарсилось): вызывающий код должен ответить 400. */
  verifyWebhookSignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): PaymentWebhookEvent | null;

  refund(providerIntentId: string, amountCents: number): Promise<{ providerRefundId: string }>;
}

export type PaymentWebhookEvent =
  | { type: 'payment.succeeded'; providerIntentId: string }
  | { type: 'payment.failed'; providerIntentId: string }
  | { type: 'payment.expired'; providerIntentId: string };

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
