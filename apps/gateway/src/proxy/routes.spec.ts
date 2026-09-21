import { matchRoute, PUBLIC_ROUTES, upstreamOfPath } from './routes';

describe('таблица публичных маршрутов', () => {
  it.each([
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/register'],
    ['POST', '/api/auth/refresh'],
    ['POST', '/api/auth/logout'],
    ['GET', '/api/catalog/events'],
    ['GET', '/api/catalog/events/mine'],
    ['GET', '/api/catalog/events/3f2c'],
    ['PATCH', '/api/catalog/events/3f2c/publish'],
    ['GET', '/api/catalog/venues'],
    ['GET', '/api/catalog/venues/v1/seats'],
    ['POST', '/api/catalog/venues/v1/seats/generate'],
    ['GET', '/api/booking/events/e1/holds'],
    ['GET', '/api/booking/events/e1/my-hold'],
    ['POST', '/api/booking/events/e1/holds'],
    ['DELETE', '/api/booking/events/e1/holds'],
    ['POST', '/api/payment/orders'],
    ['GET', '/api/payment/orders'],
    ['PATCH', '/api/payment/orders/o1/refund'],
    ['GET', '/api/payment/events/e1/sold-seats'],
    ['POST', '/api/payment/webhooks/provider'],
    ['POST', '/api/payment/dev/fake-webhook'],
  ])('%s %s — разрешён', (method, path) => {
    expect(matchRoute(method, path)).not.toBeNull();
  });

  it.each([
    // внутренний эндпоинт catalog для payment: наружу не публикуется
    ['GET', '/api/catalog/events/e1/seats/s1/ticket-info'],
    // метод не тот
    ['DELETE', '/api/catalog/events/e1'],
    ['GET', '/api/auth/login'],
    ['POST', '/api/payment/webhooks/provider/extra'],
    // несуществующее и внутреннее auth
    ['GET', '/api/auth/internal/users/u1'],
    ['GET', '/api/internal/users/u1'],
    ['GET', '/api/payment/metrics'],
    ['GET', '/api/booking'],
  ])('%s %s — не разрешён', (method, path) => {
    expect(matchRoute(method, path)).toBeNull();
  });

  it('события «mine» не попадают под кешируемый маршрут /events/:id', () => {
    expect(matchRoute('GET', '/api/catalog/events/mine')?.cacheTtlMs).toBeUndefined();
    expect(matchRoute('GET', '/api/catalog/events/abc')?.cacheTtlMs).toBeGreaterThan(0);
  });

  it('завершающий слэш не даёт обойти список и не ломает разрешённый путь', () => {
    expect(matchRoute('POST', '/api/auth/login/')).not.toBeNull();
    expect(matchRoute('GET', '/api/catalog/events/e1/seats/s1/ticket-info/')).toBeNull();
  });

  it.each([
    '/api/catalog/events/e1%2Fseats%2Fs1%2Fticket-info',
    '/api/catalog/events/e1%2fseats',
    '/api/catalog/events/..%5cadmin',
    '/api/catalog/events/../venues',
    '/api/catalog/events/./e1',
  ])('обходной путь %s отклоняется', (path) => {
    expect(matchRoute('GET', path)).toBeNull();
  });

  it('деньги: возврат и вебхуки без таймаута, остальные пути с ним', () => {
    const withoutTimeout = PUBLIC_ROUTES.filter((route) => route.noTimeout).map((route) =>
      route.path.source.replace(/\\/g, ''),
    );
    expect(withoutTimeout).toEqual([
      '^/api/payment/orders/[^/]+/refund$',
      '^/api/payment/webhooks/provider$',
      '^/api/payment/dev/fake-webhook$',
    ]);
  });

  it('вебхук провайдера не ограничивается по частоте, вход ограничен строже всех', () => {
    expect(matchRoute('POST', '/api/payment/webhooks/provider')?.rateLimit).toBe('exempt');
    expect(matchRoute('POST', '/api/auth/login')?.rateLimit).toBe('credentials');
  });

  it('только публичные GET каталога кешируются, персональные и денежные нет', () => {
    const cached = PUBLIC_ROUTES.filter((route) => route.cacheTtlMs);
    expect(cached.every((route) => route.method === 'GET' && route.upstream === 'catalog')).toBe(
      true,
    );
  });

  describe('upstreamOfPath', () => {
    it.each([
      ['/api/auth/login', 'auth'],
      ['/api/catalog', 'catalog'],
      ['/api/booking/events/e1/holds', 'booking'],
      ['/api/payment/orders', 'payment'],
    ])('%s → %s', (path, upstream) => {
      expect(upstreamOfPath(path)).toBe(upstream);
    });

    it.each(['/api/me', '/api/docs', '/api/events/e1/seat-status', '/api/authors', '/health'])(
      '%s обслуживает сам gateway',
      (path) => {
        expect(upstreamOfPath(path)).toBeNull();
      },
    );
  });
});
