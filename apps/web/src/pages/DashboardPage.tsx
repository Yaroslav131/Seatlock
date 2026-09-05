import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchMe, logout, MeResponse } from '../lib/auth-api';
import { useAuthStore } from '../lib/auth-store';
import { ApiError } from '../lib/api-client';

/**
 * Нарочно не берём email/роль из декодированного на клиенте токена —
 * этот запрос к /api/me специально доказывает, что JwtAuthGuard на
 * gateway реально пропускает запрос и что refresh честно отработал
 * бы, протухни токен прямо сейчас.
 */
export function DashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить профиль'));
  }, []);

  async function handleLogout(): Promise<void> {
    await logout().catch(() => undefined);
    setAccessToken(null);
    navigate('/login');
  }

  return (
    <div className="dashboard-page">
      <h1>Личный кабинет</h1>
      {error && <p className="auth-error">{error}</p>}
      {me && (
        <dl>
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Роль</dt>
          <dd>{me.role}</dd>
          <dt>Токен истекает</dt>
          <dd>{new Date(me.exp * 1000).toLocaleTimeString('ru-RU')}</dd>
        </dl>
      )}
      <button onClick={handleLogout}>Выйти</button>
    </div>
  );
}
