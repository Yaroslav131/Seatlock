import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventOrdersPanel } from './EventOrdersPanel';

vi.mock('../../lib/catalog-api', () => ({
  listVenueSeats: vi.fn(),
}));
vi.mock('../../lib/payment-api', () => ({
  listOrders: vi.fn(),
  refundOrder: vi.fn(),
}));

import { listVenueSeats, Seat } from '../../lib/catalog-api';
import { listOrders, Order, refundOrder } from '../../lib/payment-api';

const SEATS: Seat[] = [{ id: 'seat-1', section: null, row: 3, number: 12 }];
const PAID_ORDER: Order = {
  id: 'order-1',
  eventId: 'event-1',
  seatId: 'seat-1',
  amountCents: 150000,
  status: 'PAID',
  providerIntentId: 'fake_pi_1',
};

describe('EventOrdersPanel', () => {
  beforeEach(() => {
    vi.mocked(listVenueSeats).mockResolvedValue(SEATS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('рендерит место, цену и статус заказа', async () => {
    vi.mocked(listOrders).mockResolvedValue([PAID_ORDER]);

    render(<EventOrdersPanel eventId="event-1" venueId="venue-1" />);

    expect(await screen.findByText('Ряд 3, место 12')).toBeInTheDocument();
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
  });

  it('пустой список — сообщение без кнопок', async () => {
    vi.mocked(listOrders).mockResolvedValue([]);

    render(<EventOrdersPanel eventId="event-1" venueId="venue-1" />);

    expect(await screen.findByText('Заказов пока нет.')).toBeInTheDocument();
  });

  it('кнопка "Вернуть" только на PAID-заказах', async () => {
    vi.mocked(listOrders).mockResolvedValue([
      PAID_ORDER,
      { ...PAID_ORDER, id: 'order-2', status: 'REFUNDED' },
    ]);

    render(<EventOrdersPanel eventId="event-1" venueId="venue-1" />);

    await screen.findByText('Оплачено');
    expect(screen.getAllByRole('button', { name: 'Вернуть' })).toHaveLength(1);
  });

  it('клик "Вернуть" вызывает refundOrder и обновляет статус на REFUNDED', async () => {
    vi.mocked(listOrders).mockResolvedValue([PAID_ORDER]);
    vi.mocked(refundOrder).mockResolvedValue({ ...PAID_ORDER, status: 'REFUNDED' });

    render(<EventOrdersPanel eventId="event-1" venueId="venue-1" />);

    const refundButton = await screen.findByRole('button', { name: 'Вернуть' });
    fireEvent.click(refundButton);

    expect(refundOrder).toHaveBeenCalledWith('order-1');
    await waitFor(() => expect(screen.getByText('Возвращено')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Вернуть' })).not.toBeInTheDocument();
  });
});
