import type { JSX, ReactNode } from 'react';

interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  children: ReactNode;
}

/** Обёртка «подпись + поле + текст ошибки» — избавляет формы от повторов. */
export function Field({ label, htmlFor, error, children }: FieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
