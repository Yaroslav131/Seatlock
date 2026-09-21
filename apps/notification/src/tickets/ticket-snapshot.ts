/**
 * Данные билета, которые payment кладёт в событие order.paid (docs/adr/0005).
 * Формат зеркалит apps/payment/src/orders/ticket-snapshot.ts: это контракт
 * события между двумя сервисами, общего пакета у них нет.
 */
export interface TicketSnapshot {
  buyerEmail: string;
  eventTitle: string;
  startsAt: string;
  venueName: string;
  venueCity: string;
  venueAddress: string;
  seatSection: string | null;
  seatRow: number;
  seatNumber: number;
}

/**
 * Сообщение приходит из очереди — не доверяем форме. Любое несоответствие
 * (в том числе событие от старой версии payment, где поля ещё нет) даёт null,
 * и consumer берёт данные по-старому, через catalog и auth.
 */
export function parseTicketSnapshot(raw: unknown): TicketSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const strings = [
    'buyerEmail',
    'eventTitle',
    'startsAt',
    'venueName',
    'venueCity',
    'venueAddress',
  ] as const;
  for (const key of strings) {
    if (typeof r[key] !== 'string' || (r[key] as string).length === 0) return null;
  }
  if (typeof r.seatRow !== 'number' || typeof r.seatNumber !== 'number') return null;
  if (r.seatSection !== null && typeof r.seatSection !== 'string') return null;
  if (Number.isNaN(Date.parse(r.startsAt as string))) return null;

  return {
    buyerEmail: r.buyerEmail as string,
    eventTitle: r.eventTitle as string,
    startsAt: r.startsAt as string,
    venueName: r.venueName as string,
    venueCity: r.venueCity as string,
    venueAddress: r.venueAddress as string,
    seatSection: r.seatSection as string | null,
    seatRow: r.seatRow,
    seatNumber: r.seatNumber,
  };
}
