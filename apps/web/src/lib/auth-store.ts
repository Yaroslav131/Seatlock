import { create } from 'zustand';

interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
}

// Access-токен живёт только в памяти вкладки — не в localStorage.
// Обновление страницы его сотрёт, и это нормально: за восстановление
// сессии отвечает httpOnly-cookie с refresh-токеном, которую эта
// вкладка вообще не видит и не трогает напрямую.
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  setAccessToken: (token) => set({ accessToken: token }),
}));

export interface DecodedAccessToken {
  sub: string;
  email: string;
  role: 'USER' | 'ORGANIZER' | 'ADMIN';
  exp: number;
}

/**
 * Декодирует payload JWT без проверки подписи — только для того,
 * чтобы показать email/роль в интерфейсе. Реальную проверку токена
 * всегда делает сервер; на этом клиентском разборе нельзя строить
 * никакие решения о доступе.
 */
export function decodeAccessToken(token: string): DecodedAccessToken | null {
  try {
    const [, payload] = token.split('.');
    return JSON.parse(atob(payload)) as DecodedAccessToken;
  } catch {
    return null;
  }
}

/**
 * Удобный хук для интерфейса: «залогинен ли» и «какая роль» одним
 * вызовом — например, чтобы показать пункт меню только организатору.
 * Не источник истины для доступа — только для того, что показать.
 */
export function useCurrentUser(): DecodedAccessToken | null {
  const accessToken = useAuthStore((state) => state.accessToken);
  return accessToken ? decodeAccessToken(accessToken) : null;
}
