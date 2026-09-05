import { JSX } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../lib/auth-store';

/**
 * Пускает дальше только если в памяти есть access-токен. Это не
 * единственная защита — сервер всё равно проверит токен по подписи
 * на каждый запрос. Здесь мы просто не даём отрисоваться странице,
 * которая всё равно ничего не получит от API.
 */
export function ProtectedRoute({ children }: { children: JSX.Element }): JSX.Element {
  const accessToken = useAuthStore((state) => state.accessToken);

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
