import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Отключаем автоматический body-parser Nest: если он разберёт тело
  // запроса первым, до прокси, поток будет уже вычитан и /auth/login
  // с пустым телом улетит на auth-сервис. Прокси должен получить
  // сырые байты нетронутыми.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  // enableCors должен идти раньше прокси — иначе CORS-заголовки
  // не долетят до ответов, которые прокси отдаёт напрямую, в обход
  // остального пайплайна Nest.
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
    credentials: true,
  });

  // Единственная публичная точка входа для авторизации: снаружи виден
  // только gateway, а какой сервис реально отвечает — деталь реализации.
  // Пути совпадают один в один (у auth тоже префикс /api), переписывать
  // ничего не нужно.
  //
  // pathFilter, а не app.use('/api/auth', ...): при монтировании по пути
  // Express сам вырезает этот префикс из req.url до того, как его увидит
  // прокси, и /api/auth/register долетел бы до auth как голый /register.
  // pathFilter проверяет путь сам, не трогая req.url.
  const authServiceUrl = config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001');
  app.use(
    createProxyMiddleware({
      target: authServiceUrl,
      changeOrigin: true,
      pathFilter: '/api/auth',
    }),
  );

  // Парсер тела нужен только тем маршрутам, что реально обрабатывает
  // сам gateway — до прокси-путей он не достаёт, т.к. тот уже
  // ответил и не вызывает next().
  app.use(json());
  app.use(urlencoded({ extended: true }));

  // Health-эндпоинты выносим за префикс /api, чтобы балансировщик
  // в AWS мог опрашивать их напрямую по короткому пути.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  // /api/docs, а не /api/auth/... — сюда pathFilter прокси не достаёт,
  // маршрут остаётся на самом gateway, а не улетает на auth.
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
