import type { HTMLAttributes, JSX } from 'react';
import { cn } from '../../lib/cn';

type Tone = 'brand' | 'success' | 'warning' | 'neutral';

const toneClasses: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700 ring-brand-600/20',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  neutral: 'bg-ink-100 text-ink-600 ring-ink-500/10',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className, ...props }: BadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}
