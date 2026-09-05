import type { FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { Input } from '../components/ui/Input';
import { ApiError } from '../lib/api-client';
import { register } from '../lib/auth-api';
import { useAuthStore } from '../lib/auth-store';

export function RegisterPage(): JSX.Element {
  const navigate = useNavigate();
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { accessToken } = await register(email, password);
      setAccessToken(accessToken);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось зарегистрироваться');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 pt-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Создать аккаунт</h1>
        <p className="mt-1 text-sm text-ink-500">Это займёт меньше минуты</p>
      </div>

      <Card>
        <CardBody>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
              />
            </Field>
            <Field label="Пароль" htmlFor="password">
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
              <p className="text-xs text-ink-400">Минимум 8 символов</p>
            </Field>

            {error && <Alert>{error}</Alert>}

            <Button type="submit" loading={loading} className="mt-2 w-full">
              Зарегистрироваться
            </Button>
          </form>
        </CardBody>
      </Card>

      <p className="text-center text-sm text-ink-500">
        Уже есть аккаунт?{' '}
        <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
          Войти
        </Link>
      </p>
    </div>
  );
}
