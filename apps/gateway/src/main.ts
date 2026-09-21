// Первая строка файла — не случайность: инструментации OpenTelemetry
// (http/fetch/amqplib) патчат модули Node ДО того, как их кто-либо
// успеет импортировать. Проект компилируется в CommonJS (см.
// tsconfig.base.json), поэтому require() выполняется строго в порядке
// написанных import — если tracing.ts не первый, часть спанов первых
// же запросов может не попасть под инструментацию.
import './tracing';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './setup';

async function bootstrap(): Promise<void> {
  // Отключаем автоматический body-parser Nest: если он разберёт тело
  // запроса первым, до прокси, поток будет уже вычитан и /auth/login
  // с пустым телом улетит на auth-сервис. Прокси должен получить
  // сырые байты нетронутыми.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  configureApp(app, config);

  // /api/docs обслуживает сам gateway: пути вне /api/<сервис> прокси не трогает,
  // и запрос не улетает ни в один сервис.
  const swaggerDoc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('SeatLock — gateway').setVersion('1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/docs', app, swaggerDoc);

  // Без этого Nest не вызовет onApplicationShutdown по SIGTERM,
  // и при каждом деплое мы будем терять запросы в обработке.
  app.enableShutdownHooks();

  const port = Number(config.get<string>('GATEWAY_PORT', '3000'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`gateway слушает http://localhost:${port}`);
}

void bootstrap();
