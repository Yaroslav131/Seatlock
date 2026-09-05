import type { FormEvent, JSX } from 'react';
import { useState } from 'react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ApiError } from '../../lib/api-client';
import { generateSeats, Venue } from '../../lib/catalog-api';

/** Одна строка зала со свёрнутой формой генерации мест по клику. */
export function VenueRow({
  venue,
  onSeatsGenerated,
}: {
  venue: Venue;
  onSeatsGenerated: (venueId: string, created: number) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState('10');
  const [seatsPerRow, setSeatsPerRow] = useState('12');
  const [section, setSection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleGenerate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { created } = await generateSeats(venue.id, {
        rows: Number(rows),
        seatsPerRow: Number(seatsPerRow),
        section: section || undefined,
      });
      onSeatsGenerated(venue.id, created);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сгенерировать места');
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-ink-900">{venue.name}</p>
          <p className="text-sm text-ink-500">{venue.city}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="neutral">{venue.seatCount} мест</Badge>
          <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Отмена' : '+ Места'}
          </Button>
        </div>
      </div>

      {open && (
        <form onSubmit={handleGenerate} className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-ink-50 p-3">
          <label className="flex flex-col gap-1 text-xs text-ink-500">
            Рядов
            <Input
              type="number"
              min={1}
              max={500}
              value={rows}
              onChange={(e) => setRows(e.target.value)}
              className="w-20"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-500">
            Мест в ряду
            <Input
              type="number"
              min={1}
              max={200}
              value={seatsPerRow}
              onChange={(e) => setSeatsPerRow(e.target.value)}
              className="w-24"
              required
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-500">
            Секция (необязательно)
            <Input value={section} onChange={(e) => setSection(e.target.value)} className="w-36" />
          </label>
          <Button type="submit" size="sm" loading={loading}>
            Сгенерировать
          </Button>
          {error && <p className="w-full text-sm text-red-600">{error}</p>}
        </form>
      )}
    </li>
  );
}
