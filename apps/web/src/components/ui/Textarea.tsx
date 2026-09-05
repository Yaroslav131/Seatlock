import type { JSX, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...props }: TextareaProps): JSX.Element {
  return (
    <textarea
      className={cn(
        'w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900',
        'placeholder:text-ink-400',
        'transition-shadow focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100',
        className,
      )}
      {...props}
    />
  );
}
