import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { NavBar } from './NavBar';

export function Layout(): JSX.Element {
  return (
    <div className="min-h-screen bg-ink-50">
      <NavBar />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
