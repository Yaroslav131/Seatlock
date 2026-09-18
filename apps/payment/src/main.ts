// Первая строка файла — не случайность, см. tracing.ts.
import './tracing';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // rawBody:true, а не bodyParser:false глобально (как у gateway) —
  // остальные роуты payment получают обычный распарсенный req.body,
  // только вебхук-контроллер отдельно читает req.rawBody для проверки
  // подписи провайдера (см. webhooks/payment-webhook.controller.ts).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  app.set('trust proxy', true);
  app.setGlobalPrefix('api/payment', { exclude: ['health', 'health/ready', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const swaggerDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('SeatLock — payment').setVersion('1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/payment/docs', app, swaggerDoc);

  const port = Number(config.get<string>('PAYMENT_PORT', '3004'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`payment слушает http://localhost:${port}`);
}

void bootstrap();
