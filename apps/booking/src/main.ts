import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.set('trust proxy', true);
  app.setGlobalPrefix('api/booking', { exclude: ['health', 'health/ready'] });
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
    new DocumentBuilder().setTitle('SeatLock — booking').setVersion('1.0').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/booking/docs', app, swaggerDoc);

  const port = Number(config.get<string>('BOOKING_PORT', '3003'));
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`booking слушает http://localhost:${port}`);
}

void bootstrap();
