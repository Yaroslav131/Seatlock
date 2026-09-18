import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram } from 'prom-client';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Всего HTTP-запросов',
  labelNames: ['method', 'route', 'status'],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Длительность HTTP-запроса в секундах',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// gateway в основном не роутит запросы через свой Nest-контроллер — большая
// часть трафика уходит в createProxyMiddleware ДО того, как Nest вообще
// видит запрос (см. main.ts), поэтому обычный Nest-interceptor (как в
// остальных 5 сервисах, см. metrics.interceptor.ts) тут ничего бы не
// поймал. Вместо него — обычный Express-middleware, подключённый раньше
// прокси-блоков, который видит вообще весь трафик.
const KNOWN_PREFIXES = [
  '/api/auth',
  '/api/catalog',
  '/api/booking',
  '/api/payment',
  '/api/me',
  '/health',
];

// Реальные пути от clients содержат UUID (/api/catalog/events/<uuid>) —
// gateway, в отличие от остальных сервисов, не знает свои же
// параметризованные шаблоны маршрутов (это знание есть только у сервиса,
// который реально их обрабатывает). Группируем по известному префиксу
// вместо сырого пути — иначе метрика "взорвалась" бы уникальными label'ами.
function routeLabel(path: string): string {
  return KNOWN_PREFIXES.find((prefix) => path.startsWith(prefix)) ?? 'other';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const route = routeLabel(req.path);

  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ method: req.method, route }, durationSeconds);
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
  });

  next();
}
