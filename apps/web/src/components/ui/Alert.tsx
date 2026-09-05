import type { JSX, ReactNode } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'error' | 'success';

const toneClasses: Record<Tone, string> = {
  error: 'bg-red-50 text-red-700 ring-red-600/10',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/10',
};

export function Alert({ tone = 'error', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return (
    <div className={cn('rounded-lg px-3.5 py-2.5 text-sm ring-1 ring-inset', toneClasses[tone])} role="alert">
      {children}
    </div>
  );
}
