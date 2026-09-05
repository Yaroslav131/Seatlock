import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // auth недостижим напрямую — сюда попадают только запросы, уже
  // прошедшие через Caddy и gateway. Без этого req.ip показывал бы
  // внутренний адрес gateway на все запросы разом, и rate limit
  // считал бы всех клиентов одним и тем же "IP".
  app.set('trust proxy', true);

  // Без этого req.cookies всегда пустой — refresh-токен едет в cookie,
  // а не в теле запроса.
  app.use(cookieParser());
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const port = Number(config.get<string>('AUTH_PORT', '3001'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`auth слушает http://localhost:${port}`);
}

void bootstrap();
