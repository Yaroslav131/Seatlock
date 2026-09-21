export type UpstreamName = 'auth' | 'catalog' | 'booking' | 'payment';

// Пакет ограничений частоты, см. rate-limit/policies.ts. exempt — без лимита.
export type RatePolicyName = 'credentials' | 'orders' | 'holds' | 'default' | 'exempt';

export interface PublicRoute {
  upstream: UpstreamName;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Полный путь вместе с /api, без query-строки. */
  path: RegExp;
  rateLimit: RatePolicyName;
  /**
   * Путь, на котором деньги уже списаны или списываются (возврат, вебхук платёжного
   * провайдера): здесь gateway не имеет права обрывать запрос по таймауту. Клиент
   * ушёл бы с «ошибкой», а платёж на стороне провайдера прошёл бы. Пусть лучше
   * запрос повиснет, чем рассинхронизирует деньги и заказ.
   */
  noTimeout?: boolean;
  /** Публичный GET, который можно отдавать из кеша gateway столько миллисекунд. */
  cacheTtlMs?: number;
}

const SEGMENT = '[^/]+';
const CACHE_TTL_MS = 5_000;

/**
 * Единственный список того, что gateway пропускает наружу. Всё, чего здесь нет,
 * получает 404 на самом gateway, до похода в сервис: новый внутренний эндпоинт
 * (например, catalog `.../ticket-info` для payment) не становится публичным по
 * забывчивости, для этого его надо сначала явно записать сюда.
 *
 * Порядок важен: берётся первый подошедший маршрут, поэтому частные пути
 * (`/events/mine`) стоят раньше общих (`/events/:id`).
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  // auth
  {
    upstream: 'auth',
    method: 'POST',
    path: /^\/api\/auth\/(register|login)$/,
    rateLimit: 'credentials',
  },
  {
    upstream: 'auth',
    method: 'POST',
    path: /^\/api\/auth\/(refresh|logout)$/,
    rateLimit: 'default',
  },

  // catalog
  {
    upstream: 'catalog',
    method: 'GET',
    path: /^\/api\/catalog\/events$/,
    rateLimit: 'default',
    cacheTtlMs: CACHE_TTL_MS,
  },
  { upstream: 'catalog', method: 'POST', path: /^\/api\/catalog\/events$/, rateLimit: 'default' },
  {
    upstream: 'catalog',
    method: 'GET',
    path: /^\/api\/catalog\/events\/mine$/,
    rateLimit: 'default',
  },
  {
    upstream: 'catalog',
    method: 'PATCH',
    path: new RegExp(`^/api/catalog/events/${SEGMENT}/publish$`),
    rateLimit: 'default',
  },
  {
    upstream: 'catalog',
    method: 'GET',
    path: new RegExp(`^/api/catalog/events/${SEGMENT}$`),
    rateLimit: 'default',
    cacheTtlMs: CACHE_TTL_MS,
  },
  { upstream: 'catalog', method: 'GET', path: /^\/api\/catalog\/venues$/, rateLimit: 'default' },
  { upstream: 'catalog', method: 'POST', path: /^\/api\/catalog\/venues$/, rateLimit: 'default' },
  {
    upstream: 'catalog',
    method: 'GET',
    path: new RegExp(`^/api/catalog/venues/${SEGMENT}$`),
    rateLimit: 'default',
    cacheTtlMs: CACHE_TTL_MS,
  },
  {
    upstream: 'catalog',
    method: 'GET',
    path: new RegExp(`^/api/catalog/venues/${SEGMENT}/seats$`),
    rateLimit: 'default',
    cacheTtlMs: CACHE_TTL_MS,
  },
  {
    upstream: 'catalog',
    method: 'POST',
    path: new RegExp(`^/api/catalog/venues/${SEGMENT}/seats/generate$`),
    rateLimit: 'default',
  },

  // booking
  {
    upstream: 'booking',
    method: 'GET',
    path: new RegExp(`^/api/booking/events/${SEGMENT}/(holds|my-hold)$`),
    rateLimit: 'default',
  },
  {
    upstream: 'booking',
    method: 'POST',
    path: new RegExp(`^/api/booking/events/${SEGMENT}/holds$`),
    rateLimit: 'holds',
  },
  {
    upstream: 'booking',
    method: 'DELETE',
    path: new RegExp(`^/api/booking/events/${SEGMENT}/holds$`),
    rateLimit: 'holds',
  },

  // payment
  { upstream: 'payment', method: 'POST', path: /^\/api\/payment\/orders$/, rateLimit: 'orders' },
  { upstream: 'payment', method: 'GET', path: /^\/api\/payment\/orders$/, rateLimit: 'default' },
  {
    upstream: 'payment',
    method: 'PATCH',
    path: new RegExp(`^/api/payment/orders/${SEGMENT}/refund$`),
    rateLimit: 'default',
    noTimeout: true,
  },
  {
    upstream: 'payment',
    method: 'GET',
    path: new RegExp(`^/api/payment/events/${SEGMENT}/sold-seats$`),
    rateLimit: 'default',
  },
  {
    upstream: 'payment',
    method: 'POST',
    path: /^\/api\/payment\/webhooks\/provider$/,
    rateLimit: 'exempt',
    noTimeout: true,
  },
  {
    upstream: 'payment',
    method: 'POST',
    path: /^\/api\/payment\/dev\/fake-webhook$/,
    rateLimit: 'default',
    noTimeout: true,
  },
];

// Префиксы, за которыми стоят сервисы: запрос под таким префиксом обязан
// совпасть с PUBLIC_ROUTES, иначе 404. Остальные пути /api/* (/api/me, /api/docs,
// /api/events/:id/seat-status) обслуживает сам gateway.
const PROXIED_PREFIXES: Record<string, UpstreamName> = {
  '/api/auth': 'auth',
  '/api/catalog': 'catalog',
  '/api/booking': 'booking',
  '/api/payment': 'payment',
};

/** Какому сервису принадлежит путь (по префиксу), независимо от того, разрешён ли он. */
export function upstreamOfPath(path: string): UpstreamName | null {
  for (const [prefix, upstream] of Object.entries(PROXIED_PREFIXES)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return upstream;
    }
  }
  return null;
}

/**
 * Пути, которыми пытаются обойти список маршрутов: закодированный слэш (%2f, %5c) и
 * сегменты . / .. — сервис за gateway может разобрать их иначе, чем регулярка здесь.
 */
const SUSPICIOUS_PATH = /%2f|%5c|(^|\/)\.\.?(\/|$)/i;

export function matchRoute(method: string, path: string): PublicRoute | null {
  if (SUSPICIOUS_PATH.test(path)) {
    return null;
  }
  // Express не различает "/x" и "/x/", сервисы за gateway тоже.
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return (
    PUBLIC_ROUTES.find((route) => route.method === method && route.path.test(normalized)) ?? null
  );
}
