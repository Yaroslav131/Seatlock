import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getHeldSeats, getMyHold, Hold, holdSeat, releaseHold } from '../lib/booking-api';
import { ApiError } from '../lib/api-client';
import { listVenueSeats, Seat } from '../lib/catalog-api';
import { useCurrentUser } from '../lib/auth-store';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { cn } from '../lib/cn';

const POLL_INTERVAL_MS = 7000;

type SeatStatus = 'AVAILABLE' | 'HELD_BY_YOU' | 'HELD_BY_OTHER';

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function SeatMap({ eventId, venueId }: { eventId: string; venueId: string }): JSX.Element {
  const navigate = useNavigate();
  const user = useCurrentUser();
  // useCurrentUser() декодирует JWT заново на каждый рендер и отдаёт новый
  // объект — если положить его целиком в зависимости эффекта, поллинг ниже
  // будет пересоздаваться (и сразу же дёргать сеть) на каждый ре-рендер,
  // а не раз в POLL_INTERVAL_MS. userId — стабильный примитив для этого.
  const userId = user?.sub ?? null;

  const [seats, setSeats] = useState<Seat[]>([]);
  const [heldSeatIds, setHeldSeatIds] = useState<Set<string>>(new Set());
  const [myHold, setMyHold] = useState<Hold | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSeatId, setPendingSeatId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refreshHolds = useCallback(async () => {
    try {
      const [held, mine] = await Promise.all([
        getHeldSeats(eventId),
        userId ? getMyHold(eventId) : Promise.resolve(null),
      ]);
      setHeldSeatIds(new Set(held.map((h) => h.seatId)));
      setMyHold(mine);
    } catch {
      // Поллинг молча пробует ещё раз через POLL_INTERVAL_MS — не хотим
      // мигать баннером ошибки из-за одного пропущенного опроса.
    }
  }, [eventId, userId]);

  useEffect(() => {
    listVenueSeats(venueId)
      .then(setSeats)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Не удалось загрузить места'));
  }, [venueId]);

  useEffect(() => {
    void refreshHolds();
    const interval = setInterval(() => void refreshHolds(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshHolds]);

  // Отдельный тик раз в секунду — только для обратного отсчёта, не для
  // похода в сеть: опрашивать сервер каждую секунду ради циферок избыточно.
  useEffect(() => {
    if (!myHold) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [myHold]);

  const seatsBySection = useMemo(() => {
    const groups = new Map<string, Map<number, Seat[]>>();
    for (const seat of seats) {
      const sectionKey = seat.section ?? '';
      if (!groups.has(sectionKey)) groups.set(sectionKey, new Map());
      const rows = groups.get(sectionKey)!;
      if (!rows.has(seat.row)) rows.set(seat.row, []);
      rows.get(seat.row)!.push(seat);
    }
    return groups;
  }, [seats]);

  function statusOf(seatId: string): SeatStatus {
    if (myHold?.seatId === seatId) return 'HELD_BY_YOU';
    if (heldSeatIds.has(seatId)) return 'HELD_BY_OTHER';
    return 'AVAILABLE';
  }

  async function handleSeatClick(seatId: string): Promise<void> {
    if (!user) {
      navigate('/login');
      return;
    }
    const status = statusOf(seatId);
    if (status === 'HELD_BY_OTHER' || pendingSeatId) return;

    setError(null);
    setPendingSeatId(seatId);
    try {
      if (status === 'HELD_BY_YOU') {
        await releaseHold(eventId);
        setMyHold(null);
      } else {
        const hold = await holdSeat(eventId, seatId);
        setMyHold(hold);
      }
      await refreshHolds();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Кто-то опередил между опросами — просто обновляем карту, без баннера ошибки.
        await refreshHolds();
      } else {
        setError(err instanceof ApiError ? err.message : 'Не удалось занять место');
      }
    } finally {
      setPendingSeatId(null);
    }
  }

  const countdownMs = myHold ? new Date(myHold.expiresAt).getTime() - now : 0;

  return (
    <div className="mt-8">
      <h2 className="text-lg font-semibold text-ink-900">Выбор места</h2>

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {myHold && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-inset ring-brand-600/20">
          <p className="text-sm text-brand-800">
            Место удержано за вами — осталось{' '}
            <span className="font-mono font-semibold">{formatCountdown(countdownMs)}</span>
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={pendingSeatId === myHold.seatId}
            onClick={() => void handleSeatClick(myHold.seatId)}
          >
            Отпустить место
          </Button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-4 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-ink-300 bg-white" /> свободно
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-brand-600" /> ваше место
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-ink-300" /> занято
        </span>
      </div>

      {seats.length === 0 && !error && <p className="mt-4 text-sm text-ink-400">Загрузка карты зала…</p>}

      <div className="mt-4 flex flex-col gap-6 overflow-x-auto pb-2">
        {[...seatsBySection.entries()].map(([section, rows]) => (
          <div key={section || '—'}>
            {section && <p className="mb-2 text-xs font-medium tracking-wide text-ink-400 uppercase">{section}</p>}
            <div className="flex flex-col gap-1.5">
              {[...rows.entries()]
                .sort(([a], [b]) => a - b)
                .map(([row, rowSeats]) => (
                  <div key={row} className="flex items-center gap-1.5">
                    <span className="w-5 shrink-0 text-right font-mono text-[11px] text-ink-400">{row}</span>
                    {rowSeats.map((seat) => {
                      const status = statusOf(seat.id);
                      return (
                        <button
                          key={seat.id}
                          type="button"
                          title={`Ряд ${seat.row}, место ${seat.number}`}
                          disabled={status === 'HELD_BY_OTHER' || pendingSeatId === seat.id}
                          onClick={() => void handleSeatClick(seat.id)}
                          className={cn(
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded text-[10px] font-medium transition-colors',
                            status === 'AVAILABLE' &&
                              'border border-ink-300 bg-white text-ink-600 hover:border-brand-500 hover:text-brand-600',
                            status === 'HELD_BY_YOU' && 'bg-brand-600 text-white',
                            status === 'HELD_BY_OTHER' && 'cursor-not-allowed bg-ink-200 text-ink-400',
                            pendingSeatId === seat.id && 'opacity-60',
                          )}
                        >
                          {seat.number}
                        </button>
                      );
                    })}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
