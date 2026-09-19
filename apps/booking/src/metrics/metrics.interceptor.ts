import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Counter, Histogram } from 'prom-client';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

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

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = process.hrtime.bigint();
    // req.route?.path — шаблон маршрута (например "/:id"), а не реальные
    // значения — иначе каждый уникальный id стал бы своим label'ом и
    // метрика "взорвалась" бы по количеству уникальных значений.
    const route = req.route?.path ?? req.path;

    const record = (): void => {
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      httpRequestDuration.observe({ method: req.method, route }, durationSeconds);
      httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}
