import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PaymentWebhookService } from './payment-webhook.service';

/**
 * Сырое тело (req.rawBody), а не распарсенный JSON — проверка подписи
 * провайдера требует байты как есть. Включено через
 * NestFactory.create(AppModule, { rawBody: true }) в main.ts — не
 * bodyParser:false глобально, как у gateway (это сломало бы остальные
 * роуты payment), а нативная поддержка Nest: req.body по-прежнему
 * доступен на остальных контроллерах, req.rawBody — только здесь.
 */
@ApiTags('webhooks')
@Controller()
export class PaymentWebhookController {
  constructor(private readonly webhook: PaymentWebhookService) {}

  @ApiOperation({
    summary: 'Вебхук платёжного провайдера — публичный, подпись проверяется вручную',
  })
  @HttpCode(HttpStatus.OK)
  @Post('webhooks/provider')
  async provider(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-payment-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      throw new BadRequestException('Пустое тело вебхука');
    }
    await this.webhook.handle(req.rawBody, signature);
    return { received: true };
  }

  // Скрыт из Swagger — не часть публичного контракта, только для
  // dev/интеграционных тестов при PAYMENT_PROVIDER=fake.
  @ApiExcludeEndpoint()
  @HttpCode(HttpStatus.OK)
  @Post('dev/fake-webhook')
  async fakeWebhook(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    if (!req.rawBody) {
      throw new BadRequestException('Пустое тело вебхука');
    }
    await this.webhook.handleFakeWebhook(req.rawBody);
    return { received: true };
  }
}
