import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api-client';
import type { DecodedAccessToken } from '../lib/auth-store';
import { SeatMap } from './SeatMap';

// Компонент дёргает эти модули напрямую (getHeldSeats/getMyHold/holdSeat/
// releaseHold, listVenueSeats, useCurrentUser, useNavigate) — мокаем их,
// а не сеть, чтобы тест не зависел от api-client/fetch и проверял только
// логику самого SeatMap: какой статус места из каких ответов получается,
// что происходит по клику, и главное — не откатывает ли устаревший ответ
// уже свежее состояние (тот самый баг из прод-инцидента).
vi.mock('../lib/booking-api', () => ({
  getHeldSeats: vi.fn(),
  getMyHold: vi.fn(),
  holdSeat: vi.fn(),
  releaseHold: vi.fn(),
}));
vi.mock('../lib/catalog-api', () => ({
  listVenueSeats: vi.fn(),
}));
vi.mock('../lib/auth-store', () => ({
  useCurrentUser: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: vi.fn(),
}));

import { useCurrentUser } from '../lib/auth-store';
import { getHeldSeats, getMyHold, Hold, holdSeat, releaseHold } from '../lib/booking-api';
import { listVenueSeats, Seat } from '../lib/catalog-api';
import { useNavigate } from 'react-router-dom';

const ORGANIZER_USER: DecodedAccessToken = {
  sub: 'user-1',
  email: 'u@seatlock.fun',
  role: 'USER',
  exp: 9_999_999_999,
};

const ONE_SEAT: Seat[] = [{ id: 'seat-1', section: null, row: 1, number: 1 }];

/** Промис, который управляемо резолвится извне — нужен, чтобы задержать
 * один из двух конкурирующих ответов и проверить, кто из них выиграет. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SeatMap', () => {
  const navigateSpy = vi.fn();

  beforeEach(() => {
    vi.mocked(useNavigate).mockReturnValue(navigateSpy);
    vi.mocked(useCurrentUser).mockReturnValue(ORGANIZER_USER);
    vi.mocked(listVenueSeats).mockResolvedValue(ONE_SEAT);
    vi.mocked(getHeldSeats).mockResolvedValue([]);
    vi.mocked(getMyHold).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('свободное место рендерится кликабельным, без места в занятых/моих', async () => {
    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    expect(seat).not.toBeDisabled();
    expect(seat.className).toContain('bg-white');
  });

  it('место из getHeldSeats (не моё) рендерится серым и задизейбленным', async () => {
    vi.mocked(getHeldSeats).mockResolvedValue([{ seatId: 'seat-1' }]);

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    await waitFor(() => expect(seat).toBeDisabled());
    expect(seat.className).toContain('bg-ink-200');
  });

  it('своё место (getMyHold) рендерится выделенным и показывает баннер с отсчётом', async () => {
    vi.mocked(getMyHold).mockResolvedValue({
      seatId: 'seat-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    await waitFor(() => expect(seat.className).toContain('bg-brand-600'));
    expect(seat).not.toBeDisabled();
    expect(screen.getByText(/Место удержано за вами/)).toBeInTheDocument();
  });

  it('клик по свободному месту без логина ведёт на /login, не занимает место', async () => {
    vi.mocked(useCurrentUser).mockReturnValue(null);

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    fireEvent.click(seat);

    expect(navigateSpy).toHaveBeenCalledWith('/login');
    expect(holdSeat).not.toHaveBeenCalled();
  });

  it('клик по свободному месту в системе занимает его и обновляет карту', async () => {
    const hold: Hold = { seatId: 'seat-1', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    vi.mocked(holdSeat).mockResolvedValue(hold);
    vi.mocked(getHeldSeats)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ seatId: 'seat-1' }]);
    vi.mocked(getMyHold).mockResolvedValueOnce(null).mockResolvedValue(hold);

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    fireEvent.click(seat);

    expect(holdSeat).toHaveBeenCalledWith('event-1', 'seat-1');
    await waitFor(() => expect(seat.className).toContain('bg-brand-600'));
  });

  it('клик по своему месту отпускает его', async () => {
    vi.mocked(getMyHold).mockResolvedValue({
      seatId: 'seat-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.mocked(releaseHold).mockResolvedValue(undefined);

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const releaseButton = await screen.findByRole('button', { name: 'Отпустить место' });
    fireEvent.click(releaseButton);

    expect(releaseHold).toHaveBeenCalledWith('event-1');
  });

  it('409 при занятии — тихо обновляет карту вместо баннера с ошибкой', async () => {
    vi.mocked(holdSeat).mockRejectedValue(new ApiError('Место уже занято', 409));

    render(<SeatMap eventId="event-1" venueId="venue-1" />);

    const seat = await screen.findByTitle('Ряд 1, место 1');
    fireEvent.click(seat);

    await waitFor(() => expect(getHeldSeats).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Место уже занято')).not.toBeInTheDocument();
  });

  it(
    'регресс: устаревший (по времени старта) ответ опроса не должен ' +
      'откатывать уже применённое свежее состояние — тот самый прод-баг ' +
      '("отпустил место — оно снова показывалось занятым")',
    async () => {
      const staleHeld = deferred<{ seatId: string }[]>();
      const staleMine = deferred<Hold | null>();

      // Первый вызов (при монтировании) зависает — резолвим его позже,
      // намеренно устаревшими данными. Второй вызов (после клика) отвечает
      // сразу актуальным состоянием.
      vi.mocked(getHeldSeats)
        .mockReturnValueOnce(staleHeld.promise)
        .mockResolvedValueOnce([{ seatId: 'seat-1' }]);
      vi.mocked(getMyHold)
        .mockReturnValueOnce(staleMine.promise)
        .mockResolvedValueOnce({
          seatId: 'seat-1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      vi.mocked(holdSeat).mockResolvedValue({
        seatId: 'seat-1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      render(<SeatMap eventId="event-1" venueId="venue-1" />);

      const seat = await screen.findByTitle('Ряд 1, место 1');
      fireEvent.click(seat);

      // Второй (более поздний по старту) опрос уже применился — место моё.
      await waitFor(() => expect(seat.className).toContain('bg-brand-600'));

      // Теперь наконец резолвится первый, устаревший опрос — с данными,
      // будто место вообще ничьё. Без guard'а по refreshSeq это откатило
      // бы карту обратно на "свободно".
      staleHeld.resolve([]);
      staleMine.resolve(null);

      // Даём микрозадачам устаканиться и убеждаемся, что состояние НЕ откатилось.
      await new Promise((r) => setTimeout(r, 0));
      expect(seat.className).toContain('bg-brand-600');
      expect(screen.getByText(/Место удержано за вами/)).toBeInTheDocument();
    },
  );
});
