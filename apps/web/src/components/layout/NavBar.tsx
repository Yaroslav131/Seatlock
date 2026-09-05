import type { JSX } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { logout } from '../../lib/auth-api';
import { useAuthStore, useCurrentUser } from '../../lib/auth-store';

function LockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function NavBar(): JSX.Element {
  const navigate = useNavigate();
  const user = useCurrentUser();
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const isOrganizer = user?.role === 'ORGANIZER' || user?.role === 'ADMIN';

  async function handleLogout(): Promise<void> {
    await logout().catch(() => undefined);
    setAccessToken(null);
    navigate('/login');
  }

  return (
    <header className="border-b border-ink-200 bg-white">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 text-brand-700">
          <LockIcon />
          <span className="text-lg font-semibold tracking-tight text-ink-900">SeatLock</span>
        </Link>

        <nav className="flex items-center gap-1">
          <Link
            to="/"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-900"
          >
            События
          </Link>

          {isOrganizer && (
            <Link
              to="/organizer"
              className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-900"
            >
              Кабинет организатора
            </Link>
          )}

          {user ? (
            <>
              <Link
                to="/dashboard"
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-900"
              >
                Профиль
              </Link>
              <Button variant="ghost" size="sm" onClick={handleLogout} className="ml-1">
                Выйти
              </Button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 hover:bg-ink-50 hover:text-ink-900"
              >
                Войти
              </Link>
              <Button size="sm" className="ml-1" onClick={() => navigate('/register')}>
                Регистрация
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
