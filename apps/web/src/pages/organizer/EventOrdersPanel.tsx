import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ApiError } from '../../lib/api-client';
import { listVenueSeats, Seat } from '../../lib/catalog-api';
import { formatPrice } from '../../lib/format';
import { listOrders, Order, refundOrder } from '../../lib/payment-api';

const statusTone = {
  PENDING: 'warning',
  PAID: 'success',
  CANCELLED: 'neutral',
  REFUNDED: 'neutral',
} as const;
const statusLabel = {
  PENDING: 'Ожидает оплаты',
  PAID: 'Оплачено',
  CANCELLED: 'Отменено',
  REFUNDED: 'Возвращено',
} as const;

/** Сворачиваемая секция заказов события — по конвенции VenueRow.tsx. */
export function EventOrdersPanel({ eventId, venueId }: { eventId: string; venueId: string }): JSX.Element {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refundingId, setRefundingId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listOrders(eventId), listVenueSeats(venueId)])
      .then(([orderList, seatList]) => {
        setOrders(orderList);
        setSeats(seatList);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить заказы'));
  }, [eventId, venueId]);

  async function handleRefund(orderId: string): Promise<void> {
    setError(null);
    setRefundingId(orderId);
    try {
      const updated = await refundOrder(orderId);
      setOrders((prev) => prev!.map((order) => (order.id === orderId ? updated : order)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось вернуть заказ');
    } finally {
      setRefundingId(null);
    }
  }

  function seatLabel(seatId: string): string {
    const seat = seats.find((s) => s.id === seatId);
    if (!seat) return seatId;
    return seat.section
      ? `Секция ${seat.section}, ряд ${seat.row}, место ${seat.number}`
      : `Ряд ${seat.row}, место ${seat.number}`;
  }

  if (error) return <Alert>{error}</Alert>;
  if (!orders) return <p className="text-sm text-ink-400">Загрузка заказов…</p>;
  if (orders.length === 0) return <p className="text-sm text-ink-400">Заказов пока нет.</p>;

  return (
    <ul className="mt-2 divide-y divide-ink-100">
      {orders.map((order) => (
        <li key={order.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <div>
            <p className="text-ink-900">{seatLabel(order.seatId)}</p>
            <p className="text-ink-500">{formatPrice(order.amountCents)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={statusTone[order.status]}>{statusLabel[order.status]}</Badge>
            {order.status === 'PAID' && (
              <Button
                variant="danger"
                size="sm"
                loading={refundingId === order.id}
                onClick={() => void handleRefund(order.id)}
              >
                Вернуть
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
