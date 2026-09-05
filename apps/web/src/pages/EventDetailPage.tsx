import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { ApiError } from '../lib/api-client';
import { Event, getEvent, getVenue, Venue } from '../lib/catalog-api';
import { formatDateTime, formatPrice } from '../lib/format';

export function EventDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<Event | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    getEvent(id)
      .then((data) => {
        setEvent(data);
        return getVenue(data.venueId);
      })
      .then(setVenue)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Событие не найдено'));
  }, [id]);

  if (error) {
    return (
      <div className="mx-auto max-w-lg text-center">
        <p className="text-sm text-red-600">{error}</p>
        <Link to="/" className="mt-4 inline-block text-sm font-medium text-brand-600">
          ← Ко всем событиям
        </Link>
      </div>
    );
  }

  if (!event) {
    return <p className="text-sm text-ink-400">Загрузка…</p>;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/" className="text-sm font-medium text-ink-500 hover:text-ink-700">
        ← Ко всем событиям
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-ink-900">{event.title}</h1>
        <Badge tone="success" className="mt-2 shrink-0">
          {formatPrice(event.basePriceCents)}
        </Badge>
      </div>

      {event.description && <p className="mt-3 text-ink-600">{event.description}</p>}

      <Card className="mt-8">
        <CardBody className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Когда</p>
            <p className="mt-1 font-medium text-ink-900">{formatDateTime(event.startsAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Зал</p>
            <p className="mt-1 font-medium text-ink-900">{venue?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Город</p>
            <p className="mt-1 font-medium text-ink-900">{venue?.city ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Мест в зале</p>
            <p className="mt-1 font-medium text-ink-900">{venue?.seatCount ?? '—'}</p>
          </div>
        </CardBody>
      </Card>

      <Button disabled className="mt-8 w-full sm:w-auto">
        Выбрать место — скоро
      </Button>
    </div>
  );
}
