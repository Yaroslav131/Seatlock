import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client';
import { CheckoutPage } from './CheckoutPage';

// Компонент дёргает эти модули напрямую — мокаем их, а не сеть, тем же
// приёмом, что уже использует SeatMap.test.tsx.
vi.mock('../lib/catalog-api', () => ({
  getEvent: vi.fn(),
  getVenue: vi.fn(),
  listVenueSeats: vi.fn(),
}));
vi.mock('../lib/payment-api', () => ({
  createOrder: vi.fn(),
  confirmFakePayment: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useParams: vi.fn(),
  useSearchParams: vi.fn(),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { Event, getEvent, getVenue, listVenueSeats, Seat, Venue } from '../lib/catalog-api';
import { confirmFakePayment, createOrder, CreateOrderResponse } from '../lib/payment-api';
import { useParams, useSearchParams } from 'react-router-dom';

const EVENT: Event = {
  id: 'event-1',
  venueId: 'venue-1',
  organizerId: 'org-1',
  title: 'Тестовый концерт',
  description: null,
  startsAt: '2026-12-01T19:00:00.000Z',
  basePriceCents: 150000,
  status: 'PUBLISHED',
};
const VENUE: Venue = { id: 'venue-1', name: 'Дворец спорта', city: 'Минск', address: 'адрес', seatCount: 100 };
const SEAT: Seat = { id: 'seat-1', section: null, row: 3, number: 12 };
const ORDER: CreateOrderResponse = {
  id: 'order-1',
  eventId: 'event-1',
  seatId: 'seat-1',
  amountCents: 150000,
  status: 'PENDING',
  providerIntentId: 'fake_pi_1',
  clientSecret: 'secret',
};

describe('CheckoutPage', () => {
  beforeEach(() => {
    vi.mocked(useParams).mockReturnValue({ id: 'event-1' });
    vi.mocked(useSearchParams).mockReturnValue([
      new URLSearchParams({ seatId: 'seat-1' }),
      vi.fn(),
    ] as never);
    vi.mocked(getEvent).mockResolvedValue(EVENT);
    vi.mocked(getVenue).mockResolvedValue(VENUE);
    vi.mocked(listVenueSeats).mockResolvedValue([SEAT]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('рендерит сводку заказа после загрузки: событие, место, цена', async () => {
    render(<CheckoutPage />);

    expect(await screen.findByText('Тестовый концерт')).toBeInTheDocument();
    expect(screen.getByText('Ряд 3, место 12')).toBeInTheDocument();
    expect(screen.getByText(/1\s*500/)).toBeInTheDocument();
  });

  it('happy path: "Оплатить" создаёт заказ, подтверждает fake-вебхуком, показывает успех', async () => {
    vi.mocked(createOrder).mockResolvedValue(ORDER);
    vi.mocked(confirmFakePayment).mockResolvedValue({ received: true });

    render(<CheckoutPage />);
    const payButton = await screen.findByRole('button', { name: 'Оплатить' });
    fireEvent.click(payButton);

    await waitFor(() => expect(createOrder).toHaveBeenCalledWith('event-1', 'seat-1'));
    expect(confirmFakePayment).toHaveBeenCalledWith('fake_pi_1');
    expect(await screen.findByText(/Оплата прошла успешно/)).toBeInTheDocument();
  });

  it('createOrder падает (истёк холд) — показывает ошибку, confirmFakePayment не вызывается', async () => {
    vi.mocked(createOrder).mockRejectedValue(
      new ApiError('Вы не держите это место — сначала займите его на карте зала', 403),
    );

    render(<CheckoutPage />);
    const payButton = await screen.findByRole('button', { name: 'Оплатить' });
    fireEvent.click(payButton);

    expect(await screen.findByText(/сначала займите его на карте зала/)).toBeInTheDocument();
    expect(confirmFakePayment).not.toHaveBeenCalled();
  });

  it('confirmFakePayment падает после успешного createOrder — повтор не создаёт заказ заново', async () => {
    vi.mocked(createOrder).mockResolvedValue(ORDER);
    vi.mocked(confirmFakePayment).mockRejectedValueOnce(new ApiError('сеть моргнула', 503));
    vi.mocked(confirmFakePayment).mockResolvedValueOnce({ received: true });

    render(<CheckoutPage />);
    const payButton = await screen.findByRole('button', { name: 'Оплатить' });
    fireEvent.click(payButton);
    await screen.findByText('сеть моргнула');

    const retryButton = screen.getByRole('button', { name: 'Повторить оплату' });
    fireEvent.click(retryButton);

    expect(await screen.findByText(/Оплата прошла успешно/)).toBeInTheDocument();
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(confirmFakePayment).toHaveBeenCalledTimes(2);
  });
});
