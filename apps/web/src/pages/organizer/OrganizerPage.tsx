import type { FormEvent, JSX } from 'react';
import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Textarea';
import { ApiError } from '../../lib/api-client';
import {
  createEvent,
  createVenue,
  Event,
  listMyEvents,
  listVenues,
  publishEvent,
  Venue,
} from '../../lib/catalog-api';
import { formatDateTime, formatPrice } from '../../lib/format';
import { VenueRow } from './VenueRow';

const statusTone = { DRAFT: 'warning', PUBLISHED: 'success', CANCELLED: 'neutral' } as const;
const statusLabel = { DRAFT: 'Черновик', PUBLISHED: 'Опубликовано', CANCELLED: 'Отменено' } as const;

export function OrganizerPage(): JSX.Element {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listVenues(), listMyEvents()])
      .then(([v, e]) => {
        setVenues(v);
        setEvents(e);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные'));
  }, []);

  function handleSeatsGenerated(venueId: string, created: number): void {
    setVenues((prev) =>
      prev.map((v) => (v.id === venueId ? { ...v, seatCount: v.seatCount + created } : v)),
    );
  }

  async function handlePublish(id: string): Promise<void> {
    const updated = await publishEvent(id).catch(() => null);
    if (updated) {
      setEvents((prev) => prev.map((e) => (e.id === id ? updated : e)));
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Кабинет организатора</h1>
        <p className="mt-1 text-sm text-ink-500">Залы, места и события — всё в одном месте</p>
      </div>

      {loadError && <Alert>{loadError}</Alert>}

      <CreateVenueSection onCreated={(venue) => setVenues((prev) => [venue, ...prev])} />

      <Card>
        <CardBody>
          <h2 className="font-semibold text-ink-900">Залы</h2>
          {venues.length === 0 ? (
            <p className="mt-3 text-sm text-ink-400">Пока нет ни одного зала — создайте первый выше.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {venues.map((venue) => (
                <VenueRow key={venue.id} venue={venue} onSeatsGenerated={handleSeatsGenerated} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CreateEventSection
        venues={venues}
        onCreated={(event) => setEvents((prev) => [event, ...prev])}
      />

      <Card>
        <CardBody>
          <h2 className="font-semibold text-ink-900">Мои события</h2>
          {events.length === 0 ? (
            <p className="mt-3 text-sm text-ink-400">Пока нет ни одного события.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {events.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-ink-900">{event.title}</p>
                    <p className="text-sm text-ink-500">
                      {formatDateTime(event.startsAt)} · {formatPrice(event.basePriceCents)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={statusTone[event.status]}>{statusLabel[event.status]}</Badge>
                    {event.status === 'DRAFT' && (
                      <Button size="sm" onClick={() => handlePublish(event.id)}>
                        Опубликовать
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function CreateVenueSection({ onCreated }: { onCreated: (venue: Venue) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const venue = await createVenue({ name, city, address });
      onCreated(venue);
      setName('');
      setCity('');
      setAddress('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать зал');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <h2 className="font-semibold text-ink-900">Новый зал</h2>
        <form onSubmit={handleSubmit} className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Название" htmlFor="venue-name">
            <Input id="venue-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Город" htmlFor="venue-city">
            <Input id="venue-city" value={city} onChange={(e) => setCity(e.target.value)} required />
          </Field>
          <Field label="Адрес" htmlFor="venue-address">
            <Input
              id="venue-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          </Field>
          {error && (
            <div className="sm:col-span-3">
              <Alert>{error}</Alert>
            </div>
          )}
          <Button type="submit" loading={loading} className="sm:col-span-3 sm:w-auto sm:justify-self-start">
            Создать зал
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function CreateEventSection({
  venues,
  onCreated,
}: {
  venues: Venue[];
  onCreated: (event: Event) => void;
}): JSX.Element {
  const [venueId, setVenueId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const created = await createEvent({
        venueId,
        title,
        description: description || undefined,
        startsAt: new Date(startsAt).toISOString(),
        basePriceCents: Math.round(Number(price) * 100),
      });
      onCreated(created);
      setTitle('');
      setDescription('');
      setStartsAt('');
      setPrice('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать событие');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <h2 className="font-semibold text-ink-900">Новое событие</h2>
        <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-4">
          <Field label="Зал" htmlFor="event-venue">
            <Select
              id="event-venue"
              value={venueId}
              onChange={(e) => setVenueId(e.target.value)}
              required
            >
              <option value="" disabled>
                Выберите зал…
              </option>
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name} ({venue.city})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Название события" htmlFor="event-title">
            <Input id="event-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>

          <Field label="Описание (необязательно)" htmlFor="event-description">
            <Textarea
              id="event-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Дата и время" htmlFor="event-starts-at">
              <Input
                id="event-starts-at"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
              />
            </Field>
            <Field label="Цена, ₽" htmlFor="event-price">
              <Input
                id="event-price"
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </Field>
          </div>

          {error && <Alert>{error}</Alert>}

          <Button type="submit" loading={loading} className="sm:w-auto sm:self-start">
            Создать черновик
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
