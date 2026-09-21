import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './infra/tokens';
import { requestIdMiddleware } from './http/request-id';
import { metricsMiddleware } from './metrics/metrics';
import { createGatewayProxy } from './proxy/gateway-proxy';
import { createRateLimitMiddleware } from './rate-limit/rate-limit.middleware';
import { RedisRateLimiter } from './rate-limit/redis-rate-limiter';

/**
 * Всё, что gateway настраивает вручную поверх Nest. Вынесено из main.ts, чтобы
 * интеграционный тест собирал ровно то же приложение, а не его копию: раньше
 * порядок middleware дублировался в тесте, и расхождение осталось бы незамеченным.
 *
 * Порядок здесь важен, каждый слой видит запрос раньше следующих:
 * request-id → метрики → CORS → лимит частоты → прокси к сервисам → парсер тела → Nest.
 */
export function configureApp(app: NestExpressApplication, config: ConfigService): void {
  // Сколько прокси стоит перед gateway (в проде Caddy, то есть 1). От этого зависит,
  // какому адресу из X-Forwarded-For верить: при `true` любой клиент подделал бы
  // свой IP заголовком и обошёл лимит.
  app.set('trust proxy', Number(config.get<string>('TRUST_PROXY_HOPS', '1')));

  app.use(requestIdMiddleware);

  // Раньше всех остальных слоёв: иначе он не увидел бы значительную часть трафика,
  // включая отклонённое лимитом и прокси (см. metrics/metrics.ts).
  app.use(metricsMiddleware);

  // enableCors должен идти раньше прокси: иначе CORS-заголовки не долетят до
  // ответов, которые прокси отдаёт напрямую, в обход остального пайплайна Nest.
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN', 'http://localhost:5173'),
    credentials: true,
    exposedHeaders: ['x-request-id', 'retry-after'],
  });

  app.use(
    createRateLimitMiddleware({
      limiter: new RedisRateLimiter(app.get<Redis>(REDIS_CLIENT)),
      enabled: config.get<string>('RATE_LIMIT_ENABLED', 'true') !== 'false',
      bypassIps: new Set(
        config
          .get<string>('RATE_LIMIT_BYPASS_IPS', '')
          .split(',')
          .map((ip) => ip.trim())
          .filter(Boolean),
      ),
    }),
  );

  // Единственная публичная точка входа к сервисам: снаружи виден только gateway,
  // а какой сервис реально отвечает и какие у него пути, деталь реализации.
  // Пути совпадают один в один (у сервисов тот же префикс /api/...), переписывать
  // ничего не нужно. Что пропускается, задаёт proxy/routes.ts.
  app.use(
    createGatewayProxy({
      targets: {
        auth: config.get<string>('AUTH_SERVICE_URL', 'http://localhost:3001'),
        catalog: config.get<string>('CATALOG_SERVICE_URL', 'http://localhost:3002'),
        booking: config.get<string>('BOOKING_SERVICE_URL', 'http://localhost:3003'),
        payment: config.get<string>('PAYMENT_SERVICE_URL', 'http://localhost:3004'),
      },
      timeoutMs: Number(config.get<string>('UPSTREAM_TIMEOUT_MS', '15000')),
    }),
  );

  // Парсер тела нужен только тем маршрутам, что реально обрабатывает сам gateway.
  // До прокси-путей он не достаёт (тот уже ответил), а Nest создаётся с
  // bodyParser: false, иначе тело вычиталось бы раньше прокси и до сервиса
  // долетал бы пустой запрос.
  app.use(json());
  app.use(urlencoded({ extended: true }));

  // Health-эндпоинты вне префикса /api, чтобы балансировщик мог опрашивать их коротким путём.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'metrics'] });
}
