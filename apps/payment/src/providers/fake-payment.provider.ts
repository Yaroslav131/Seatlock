import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PaymentProviderPort, PaymentWebhookEvent } from './payment-provider.port';

const KNOWN_EVENT_TYPES = new Set<PaymentWebhookEvent['type']>([
  'payment.succeeded',
  'payment.failed',
  'payment.expired',
]);

/**
 * Детерминированная in-memory реализация — ничего не хранит (провайдеру
 * это и не нужно, состояние заказа живёт в нашей БД). "Вебхук" от этого
 * провайдера никто реально не шлёт — его симулирует
 * PaymentWebhookController.triggerFakeWebhook (dev/test-only эндпоинт),
 * который вызывает тот же самый внутренний обработчик, что дёрнул бы
 * настоящий вебхук — так saga-код прогоняется целиком без реального
 * провайдера.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProviderPort {
  private readonly logger = new Logger(FakePaymentProvider.name);

  createPaymentIntent(params: {
    amountCents: number;
    currency: string;
    metadata: Record<string, string>;
  }): Promise<{ providerIntentId: string; clientSecret: string }> {
    const providerIntentId = `fake_pi_${randomUUID()}`;
    this.logger.debug(
      `createPaymentIntent: ${providerIntentId}, ${params.amountCents} ${params.currency}, metadata=${JSON.stringify(params.metadata)}`,
    );
    return Promise.resolve({
      providerIntentId,
      clientSecret: `fake_secret_${randomUUID()}`,
    });
  }

  verifyWebhookSignature(rawBody: Buffer): PaymentWebhookEvent | null {
    // Fake-режим не проверяет подпись по-настоящему — только форму
    // тела. Реальный адаптер здесь будет сверять HMAC-подпись из
    // заголовка через SDK провайдера.
    try {
      const parsed = JSON.parse(rawBody.toString('utf-8')) as {
        providerIntentId?: unknown;
        type?: unknown;
      };
      if (
        typeof parsed.providerIntentId !== 'string' ||
        typeof parsed.type !== 'string' ||
        !KNOWN_EVENT_TYPES.has(parsed.type as PaymentWebhookEvent['type'])
      ) {
        return null;
      }
      return {
        type: parsed.type,
        providerIntentId: parsed.providerIntentId,
      } as PaymentWebhookEvent;
    } catch {
      return null;
    }
  }

  refund(providerIntentId: string, amountCents: number): Promise<{ providerRefundId: string }> {
    this.logger.debug(`refund: ${providerIntentId}, ${amountCents}`);
    return Promise.resolve({ providerRefundId: `fake_re_${randomUUID()}` });
  }
}
