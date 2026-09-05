import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Health-эндпоинты выносим за префикс /api, чтобы балансировщик
  // в AWS мог опрашивать их напрямую по короткому пути.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
    credentials: true,
  });

  // Без этого Nest не вызовет onApplicationShutdown по SIGTERM,
  // и при каждом деплое мы будем терять запросы в обработке.
  app.enableShutdownHooks();

  const port = Number(config.get<string>('GATEWAY_PORT', '3000'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`gateway слушает http://localhost:${port}`);
}

void bootstrap();
