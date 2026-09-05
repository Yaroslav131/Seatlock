import type { InputHTMLAttributes, JSX } from 'react';
import { cn } from '../../lib/cn';

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...props }: InputProps): JSX.Element {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg border border-ink-200 bg-white px-3 text-sm text-ink-900',
        'placeholder:text-ink-400',
        'transition-shadow focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100',
        'disabled:bg-ink-50 disabled:text-ink-400',
        className,
      )}
      {...props}
    />
  );
}
