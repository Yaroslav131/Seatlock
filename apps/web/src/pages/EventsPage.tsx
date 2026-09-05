import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardBody } from '../components/ui/Card';
import { ApiError } from '../lib/api-client';
import { Event, listPublishedEvents } from '../lib/catalog-api';
import { formatDateTime, formatPrice } from '../lib/format';

export function EventsPage(): JSX.Element {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPublishedEvents()
      .then(setEvents)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить события'));
  }, []);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Ближайшие события</h1>
        <p className="mt-1 text-sm text-ink-500">Выберите мероприятие и забронируйте место</p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {events && events.length === 0 && (
        <Card>
          <CardBody className="py-12 text-center text-sm text-ink-500">
            Пока нет опубликованных событий — загляните позже.
          </CardBody>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {events?.map((event) => (
          <Link key={event.id} to={`/events/${event.id}`} className="group">
            <Card className="h-full transition-shadow group-hover:shadow-md group-hover:shadow-ink-900/10">
              <CardBody className="flex h-full flex-col">
                <p className="text-xs font-medium tracking-wide text-brand-600 uppercase">
                  {formatDateTime(event.startsAt)}
                </p>
                <h2 className="mt-2 text-lg font-semibold text-ink-900 group-hover:text-brand-700">
                  {event.title}
                </h2>
                {event.description && (
                  <p className="mt-1 line-clamp-2 text-sm text-ink-500">{event.description}</p>
                )}
                <p className="mt-auto pt-4 text-sm font-medium text-ink-700">
                  от {formatPrice(event.basePriceCents)}
                </p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
