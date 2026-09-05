import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RequireRole } from './components/RequireRole';
import { refreshAccessToken } from './lib/api-client';
import { DashboardPage } from './pages/DashboardPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { EventsPage } from './pages/EventsPage';
import { LoginPage } from './pages/LoginPage';
import { OrganizerPage } from './pages/organizer/OrganizerPage';
import { RegisterPage } from './pages/RegisterPage';

export function App(): JSX.Element {
  // Access-токен живёт только в памяти и пропадает при каждой
  // перезагрузке страницы — но httpOnly-cookie с refresh-токеном
  // reload переживает. Прежде чем решать, что показывать, даём
  // один шанс тихо обменять её на новый access-токен.
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    refreshAccessToken().finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) {
    return <div className="min-h-screen bg-ink-50" aria-busy="true" />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
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
        <Route
          path="/organizer"
          element={
            <ProtectedRoute>
              <RequireRole roles={['ORGANIZER', 'ADMIN']}>
                <OrganizerPage />
              </RequireRole>
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
