import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { refreshAccessToken } from './lib/api-client';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';

export function App(): JSX.Element {
  // Access-токен живёт только в памяти и пропадает при каждой
  // перезагрузке страницы — но httpOnly-cookie с refresh-токеном
  // reload переживает. Прежде чем решать, пускать на /dashboard или
  // нет, даём один шанс тихо обменять её на новый access-токен.
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    refreshAccessToken().finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) {
    return <div className="session-check" aria-busy="true" />;
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
