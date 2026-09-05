import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

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
