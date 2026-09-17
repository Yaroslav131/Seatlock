import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardBody } from '../components/ui/Card';
import { ApiError } from '../lib/api-client';
import { Event, getEvent, getVenue, listVenueSeats, Seat, Venue } from '../lib/catalog-api';
import { formatDateTime, formatPrice } from '../lib/format';
import { confirmFakePayment, createOrder, CreateOrderResponse } from '../lib/payment-api';

type Phase = 'idle' | 'paying' | 'paid' | 'error';

export function CheckoutPage(): JSX.Element {
  const { id: eventId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const seatId = searchParams.get('seatId');

  const [event, setEvent] = useState<Event | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [order, setOrder] = useState<CreateOrderResponse | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    getEvent(eventId)
      .then((data) => {
        setEvent(data);
        return Promise.all([getVenue(data.venueId), listVenueSeats(data.venueId)]);
      })
      .then(([venueData, seats]) => {
        setVenue(venueData);
        setSeat(seats.find((s) => s.id === seatId) ?? null);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : 'Событие не найдено'));
  }, [eventId, seatId]);

  // Порядок важен для повторной попытки: если createOrder уже прошёл,
  // а confirmFakePayment упал (сеть) — повторный клик НЕ создаёт заказ
  // заново. Второй заказ на то же место наткнётся на частичный уникальный
  // индекс в payment (409) — для пользователя это выглядело бы как чужая
  // ошибка вместо простого "попробуйте ещё раз".
  async function handlePay(): Promise<void> {
    if (!eventId || !seatId) return;
    setError(null);
    setPhase('paying');
    try {
      const currentOrder = order ?? (await createOrder(eventId, seatId));
      setOrder(currentOrder);
      await confirmFakePayment(currentOrder.providerIntentId!);
      setPhase('paid');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось завершить оплату');
      setPhase('error');
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-lg text-center">
        <p className="text-sm text-red-600">{loadError}</p>
        <Link to="/" className="mt-4 inline-block text-sm font-medium text-brand-600">
          ← Ко всем событиям
        </Link>
      </div>
    );
  }

  if (!event || !seatId) {
    return <p className="text-sm text-ink-400">Загрузка…</p>;
  }

  if (phase === 'paid') {
    return (
      <div className="mx-auto max-w-lg text-center">
        <Badge tone="success" className="mb-4">
          Оплачено
        </Badge>
        <h1 className="text-2xl font-semibold text-ink-900">Оплата прошла успешно</h1>
        <p className="mt-2 text-ink-600">
          Билет с QR-кодом отправлен на вашу почту — проверьте входящие через пару минут.
        </p>
        <Link to="/" className="mt-6 inline-block text-sm font-medium text-brand-600">
          На главную
        </Link>
      </div>
    );
  }

  const seatLabel = seat
    ? seat.section
      ? `Секция ${seat.section}, ряд ${seat.row}, место ${seat.number}`
      : `Ряд ${seat.row}, место ${seat.number}`
    : '—';

  return (
    <div className="mx-auto max-w-lg">
      <Link to={`/events/${eventId}`} className="text-sm font-medium text-ink-500 hover:text-ink-700">
        ← Назад к событию
      </Link>

      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink-900">Оформление заказа</h1>

      <Card className="mt-6">
        <CardBody className="grid grid-cols-2 gap-6">
          <div className="col-span-2">
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Событие</p>
            <p className="mt-1 font-medium text-ink-900">{event.title}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Когда</p>
            <p className="mt-1 font-medium text-ink-900">{formatDateTime(event.startsAt)}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Место</p>
            <p className="mt-1 font-medium text-ink-900">{seatLabel}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">Зал</p>
            <p className="mt-1 font-medium text-ink-900">{venue?.name ?? '—'}</p>
          </div>
          <div>
            <p className="text-xs font-medium tracking-wide text-ink-400 uppercase">К оплате</p>
            <p className="mt-1 font-medium text-ink-900">{formatPrice(event.basePriceCents)}</p>
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <Button
        variant="primary"
        className="mt-6 w-full"
        loading={phase === 'paying'}
        onClick={() => void handlePay()}
      >
        {phase === 'error' ? 'Повторить оплату' : 'Оплатить'}
      </Button>
    </div>
  );
}
