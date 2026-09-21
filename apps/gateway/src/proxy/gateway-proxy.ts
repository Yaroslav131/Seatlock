import type { ServerResponse } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { TtlCache } from '../cache/ttl-cache';
import { isTimeoutError } from '../http/errors';
import {
  gatewayBlockedTotal,
  gatewayCacheTotal,
  gatewayUpstreamErrorsTotal,
} from '../metrics/metrics';
import { matchRoute, upstreamOfPath, type PublicRoute, type UpstreamName } from './routes';

export interface GatewayProxyOptions {
  targets: Record<UpstreamName, string>;
  /** Сколько ждать ответ сервиса на обычных путях; на путях с деньгами (noTimeout) не ограничиваем. */
  timeoutMs: number;
}

interface CachedResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
}

// Момент прихода запроса: по нему отличаем оборванное по таймауту соединение от
// упавшего сервиса (в обоих случаях прокси видит одно и то же ECONNRESET).
const startedAt = new WeakMap<object, number>();

function sendJsonError(res: ServerResponse | Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ statusCode: status, message }));
}

function notFound(res: Response): void {
  gatewayBlockedTotal.inc();
  res.status(404).json({ statusCode: 404, message: 'Not Found', error: 'Not Found' });
}

/**
 * Единая точка входа для запросов к сервисам за gateway: пропускает только маршруты
 * из PUBLIC_ROUTES, ограничивает ожидание там, где это безопасно, отдаёт часть
 * публичных GET из кеша. Всё, что не /api/<сервис>, пропускает дальше (next()).
 */
export function createGatewayProxy(options: GatewayProxyOptions): RequestHandler {
  const proxies = new Map<string, RequestHandler>();
  const cache = new TtlCache<CachedResponse>();

  function proxyFor(route: PublicRoute): RequestHandler {
    const withTimeout = route.noTimeout !== true;
    const key = `${route.upstream}:${withTimeout ? 'timeout' : 'none'}`;
    let proxy = proxies.get(key);
    if (!proxy) {
      proxy = createProxyMiddleware({
        target: options.targets[route.upstream],
        changeOrigin: true,
        ...(withTimeout ? { proxyTimeout: options.timeoutMs } : {}),
        on: {
          error: (err, req, res) => {
            if (!('writeHead' in res) || res.destroyed) {
              return; // клиент уже ушёл, отвечать некому
            }
            const started = startedAt.get(req) ?? Date.now();
            const code = (err as NodeJS.ErrnoException).code;
            const timedOut =
              withTimeout &&
              code === 'ECONNRESET' &&
              Date.now() - started >= options.timeoutMs - 100;
            gatewayUpstreamErrorsTotal.inc({
              service: route.upstream,
              kind: timedOut ? 'timeout' : 'unreachable',
            });
            if (timedOut) {
              sendJsonError(res, 504, 'Сервис не ответил вовремя');
            } else {
              sendJsonError(res, 502, 'Сервис временно недоступен');
            }
          },
        },
      }) as unknown as RequestHandler;
      proxies.set(key, proxy);
    }
    return proxy;
  }

  // Ключ и запрос к сервису строятся по пути без query-строки: кешируемые GET параметров
  // не принимают, а иначе перебор `?x=1,2,3` вытеснял бы полезные записи и обходил кеш.
  async function load(
    route: PublicRoute,
    req: Request,
  ): Promise<{ value: CachedResponse; cacheable: boolean }> {
    const headers: Record<string, string> = {};
    const accept = req.headers.accept;
    if (typeof accept === 'string') headers.accept = accept;
    const requestId = req.headers['x-request-id'];
    if (typeof requestId === 'string') headers['x-request-id'] = requestId;

    const response = await fetch(`${options.targets[route.upstream]}${req.path}`, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      value: { status: response.status, contentType: response.headers.get('content-type'), body },
      // Только успешные ответы: 404 на несуществующее событие через секунду может
      // стать 200, а 5xx кешировать нельзя вообще.
      cacheable: response.status === 200,
    };
  }

  async function serveCached(route: PublicRoute, req: Request, res: Response): Promise<void> {
    try {
      const { value, source } = await cache.get(req.path, route.cacheTtlMs!, () =>
        load(route, req),
      );
      gatewayCacheTotal.inc({ result: source });
      if (value.contentType) res.setHeader('content-type', value.contentType);
      res.setHeader('x-cache', source.toUpperCase());
      res.status(value.status).send(value.body);
    } catch (err) {
      const timedOut = isTimeoutError(err);
      gatewayUpstreamErrorsTotal.inc({
        service: route.upstream,
        kind: timedOut ? 'timeout' : 'unreachable',
      });
      if (timedOut) {
        sendJsonError(res, 504, 'Сервис не ответил вовремя');
      } else {
        sendJsonError(res, 502, 'Сервис временно недоступен');
      }
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const upstream = upstreamOfPath(req.path);
    if (!upstream) {
      next();
      return;
    }
    const route = matchRoute(req.method, req.path);
    if (!route || route.upstream !== upstream) {
      notFound(res);
      return;
    }
    startedAt.set(req, Date.now());

    // Кешируем только анонимные запросы: ответ на запрос с токеном или cookie может
    // зависеть от пользователя, и отдавать его другому нельзя.
    const anonymous = !req.headers.authorization && !req.headers.cookie;
    if (route.cacheTtlMs && anonymous) {
      void serveCached(route, req, res);
      return;
    }
    proxyFor(route)(req, res, next);
  };
}
