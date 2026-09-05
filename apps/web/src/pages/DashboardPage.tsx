import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Badge } from '../components/ui/Badge';
import { Card, CardBody } from '../components/ui/Card';
import { ApiError } from '../lib/api-client';
import { fetchMe, MeResponse } from '../lib/auth-api';

const roleLabels: Record<string, string> = {
  USER: 'Пользователь',
  ORGANIZER: 'Организатор',
  ADMIN: 'Администратор',
};

/**
 * Нарочно не берём email/роль из декодированного на клиенте токена —
 * этот запрос к /api/me специально доказывает, что JwtAuthGuard на
 * gateway реально пропускает запрос и что refresh честно отработал
 * бы, протухни токен прямо сейчас.
 */
export function DashboardPage(): JSX.Element {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить профиль'));
  }, []);

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Личный кабинет</h1>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {me && (
        <Card className="mt-6">
          <CardBody className="flex flex-col gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-lg font-semibold text-brand-700">
                {me.email[0]?.toUpperCase()}
              </div>
              <div>
                <p className="font-medium text-ink-900">{me.email}</p>
                <Badge tone="brand" className="mt-1">
                  {roleLabels[me.role] ?? me.role}
                </Badge>
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-4 border-t border-ink-100 pt-4 text-sm">
              <div>
                <dt className="text-ink-400">Access-токен истекает</dt>
                <dd className="mt-0.5 font-medium text-ink-700">
                  {new Date(me.exp * 1000).toLocaleTimeString('ru-RU')}
                </dd>
              </div>
              <div>
                <dt className="text-ink-400">Id пользователя</dt>
                <dd className="mt-0.5 truncate font-mono text-xs text-ink-500">{me.sub}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
