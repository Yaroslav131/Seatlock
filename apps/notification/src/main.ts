import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // У сервиса нет публичных бизнес-эндпоинтов — вся работа
  // асинхронная через RabbitMQ, единственный HTTP-путь — /health для
  // Docker HEALTHCHECK. Поэтому gateway его не проксирует и глобальный
  // префикс api/notification не нужен (он был бы не для чего).
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.enableShutdownHooks();

  const port = Number(config.get<string>('NOTIFICATION_PORT', '3005'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`notification слушает http://localhost:${port}`);
}

void bootstrap();
