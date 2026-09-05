import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';
import { useCurrentUser } from '../lib/auth-store';

type Role = 'USER' | 'ORGANIZER' | 'ADMIN';

/**
 * Прячет страницу от роли, которой она не предназначена — чисто
 * для UX (не показывать организаторский кабинет обычному юзеру).
 * Настоящую защиту всё равно делает RolesGuard на самом catalog —
 * это не заменяет её, а просто не даёт зайти туда, откуда сервер
 * и так всё отклонит.
 */
export function RequireRole({
  roles,
  children,
}: {
  roles: Role[];
  children: JSX.Element;
}): JSX.Element {
  const user = useCurrentUser();

  if (!user || !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
