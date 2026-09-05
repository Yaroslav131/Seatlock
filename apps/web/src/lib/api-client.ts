import { useAuthStore } from './auth-store';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function rawFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...options,
    // Без этого браузер не отправит и не примет httpOnly-cookie
    // с refresh-токеном — она едет отдельно от заголовков, которые
    // мы выставляем руками.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Обменивает refresh-cookie на новый access-токен. Дедуплицирует
 * параллельные вызовы: если несколько запросов одновременно поймали
 * 401, обновление сессии должно произойти один раз, а не N раз подряд.
 *
 * Экспортирована: её же вызывает App при старте приложения, чтобы
 * тихо восстановить сессию после перезагрузки страницы — cookie
 * переживает reload, а access-токен в памяти нет.
 */
export function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = rawFetch('/api/auth/refresh', { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) return false;
        const { accessToken } = (await res.json()) as { accessToken: string };
        useAuthStore.getState().setAccessToken(accessToken);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/**
 * Обёртка над fetch для запросов, требующих авторизации: подставляет
 * access-токен и один раз молча пробует обновить сессию при 401,
 * прежде чем сдаться и вернуть ошибку вызывающему коду.
 */
export async function authFetch<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = useAuthStore.getState().accessToken;

  const res = await rawFetch(path, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (res.status === 401 && retry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return authFetch<T>(path, options, false);
    }
    useAuthStore.getState().setAccessToken(null);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? `Запрос завершился с ошибкой ${res.status}`, res.status);
  }

  if (res.status === HTTP_NO_CONTENT) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

const HTTP_NO_CONTENT = 204;

/** Запрос без авторизации — для register/login, куда токен ещё не нужен. */
export async function publicFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, options);

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? `Запрос завершился с ошибкой ${res.status}`, res.status);
  }

  return (await res.json()) as T;
}
