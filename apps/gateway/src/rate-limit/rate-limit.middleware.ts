import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { gatewayRateLimitErrorsTotal, gatewayRateLimitedTotal } from '../metrics/metrics';
import { matchRoute } from '../proxy/routes';
import { RATE_POLICIES } from './policies';
import type { RedisRateLimiter } from './redis-rate-limiter';

export interface RateLimitOptions {
  limiter: RedisRateLimiter;
  enabled: boolean;
  /** Адреса без лимита (свой нагрузочный генератор, мониторинг). */
  bypassIps: ReadonlySet<string>;
}

// Сообщение об ошибке Redis пишем не чаще раза в 30 секунд: иначе при его падении
// лог заполнится по строке на каждый запрос.
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Лимит частоты по IP. Политика зависит от маршрута (см. PUBLIC_ROUTES): у входа
 * строже, у обычного чтения мягче, у вебхука платёжного провайдера лимита нет вовсе:
 * отказ ему обошёлся бы дороже, чем любая нагрузка.
 *
 * IP берётся из req.ip, а он верен, только если trust proxy настроен на реальное
 * число прокси перед gateway (см. setup.ts), иначе все клиенты выглядят как Caddy.
 */
export function createRateLimitMiddleware(options: RateLimitOptions): RequestHandler {
  const logger = new Logger('RateLimit');
  let lastErrorLoggedAt = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!options.enabled || !req.path.startsWith('/api/')) {
      next();
      return;
    }
    const ip = req.ip ?? 'unknown';
    if (options.bypassIps.has(ip)) {
      next();
      return;
    }

    // Путь вне таблицы (/api/me, /api/events/.../seat-status) считаем обычным
    // чтением. Неразрешённые пути сервисов отсечёт прокси, но и они тратят лимит:
    // так перебор адресов не бесплатен.
    const policyName = matchRoute(req.method, req.path)?.rateLimit ?? 'default';
    if (policyName === 'exempt') {
      next();
      return;
    }
    const policy = RATE_POLICIES[policyName];

    // then(успех, сбой), а не then().catch(): иначе исключение из next() (ниже по
    // цепочке) попало бы в catch и next() вызвался бы второй раз.
    options.limiter.hit(`rl:${policyName}:${ip}`, policy.limit, policy.windowMs).then(
      (result) => {
        if (result.allowed) {
          next();
          return;
        }
        gatewayRateLimitedTotal.inc({ policy: policyName });
        const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.status(429).set('Retry-After', String(retryAfterSeconds)).json({
          statusCode: 429,
          message: 'Слишком много запросов, попробуйте позже',
          retryAfterSeconds,
        });
      },
      (error: unknown) => {
        gatewayRateLimitErrorsTotal.inc();
        const now = Date.now();
        if (now - lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
          lastErrorLoggedAt = now;
          logger.warn(`проверка лимита не удалась, запросы пропускаются: ${String(error)}`);
        }
        next();
      },
    );
  };
}
