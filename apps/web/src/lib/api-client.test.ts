import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authFetch, publicFetch, refreshAccessToken } from './api-client';
import { useAuthStore } from './auth-store';

// Настоящие Response-объекты (Node/undici их даёт глобально даже под
// jsdom-окружением) — точнее, чем рукописная заглушка: .text()/.json()
// ведут себя ровно так же, как в реальном fetch, включая падение на
// пустом теле, которое мы здесь и регрессируем.
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe('authFetch / publicFetch', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccessToken('token-123');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    'регресс: 200 с пустым телом не должен падать — раньше res.json() ' +
      'бросал SyntaxError на пустой строке (реальный прод-баг, см. ' +
      'apps/booking GET /my-hold без активного холда)',
    async () => {
      vi.mocked(fetch).mockResolvedValue(emptyResponse(200));

      await expect(authFetch('/api/booking/events/e1/my-hold')).resolves.toBeUndefined();
    },
  );

  it('204 без тела тоже отдаёт undefined, не пытаясь распарсить JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(emptyResponse(204));

    await expect(
      authFetch('/api/booking/events/e1/holds', { method: 'DELETE' }),
    ).resolves.toBeUndefined();
  });

  it('непустое тело парсится и возвращается как есть', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { seatId: 'A-1' }));

    await expect(authFetch('/api/booking/events/e1/my-hold')).resolves.toEqual({ seatId: 'A-1' });
  });

  it('authFetch подставляет Bearer-заголовок из auth-store', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await authFetch('/api/me');

    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  it('на не-ok ответе бросает ApiError с сообщением сервера и статусом', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { message: 'Нет доступа' }));

    await expect(authFetch('/api/catalog/venues', { method: 'POST' })).rejects.toMatchObject({
      message: 'Нет доступа',
      status: 403,
    });
  });

  it('publicFetch не подставляет Authorization вообще', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }));

    await publicFetch('/api/catalog/events');

    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect((options?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('publicFetch на пустом теле тоже не падает', async () => {
    vi.mocked(fetch).mockResolvedValue(emptyResponse(200));

    await expect(publicFetch('/api/booking/events/e1/holds')).resolves.toBeUndefined();
  });
});

describe('authFetch — 401 и молчаливое обновление сессии', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccessToken('stale-token');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('на 401 один раз пробует refresh и повторяет исходный запрос с новым токеном', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(emptyResponse(401)) // первая попытка — старый токен протух
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh-token' })) // refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // повтор с новым токеном

    const result = await authFetch('/api/me');

    expect(result).toEqual({ ok: true });
    expect(useAuthStore.getState().accessToken).toBe('fresh-token');
    const [, retryOptions] = vi.mocked(fetch).mock.calls[2];
    expect((retryOptions?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fresh-token',
    );
  });

  it('если refresh тоже проваливается — сбрасывает токен и отдаёт исходную ошибку', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(emptyResponse(401))
      .mockResolvedValueOnce(emptyResponse(401)); // refresh тоже не прошёл

    await expect(authFetch('/api/me')).rejects.toBeInstanceOf(ApiError);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});

describe('refreshAccessToken', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccessToken(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('дедуплицирует параллельные вызовы — один и тот же промис на все', async () => {
    let resolveRefresh: (res: Response) => void = () => {};
    vi.mocked(fetch).mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const first = refreshAccessToken();
    const second = refreshAccessToken();
    expect(first).toBe(second);

    resolveRefresh(jsonResponse(200, { accessToken: 'x' }));
    await first;

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
