/**
 * Данные билета, снятые при создании заказа и переданные в order.paid
 * (docs/adr/0005). Формат зеркалит apps/notification/src/tickets/ticket-snapshot.ts:
 * это контракт события между двумя сервисами, общего пакета у них нет.
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

export type CatalogTicketInfo = Omit<TicketSnapshot, 'buyerEmail'>;

/** Ответ каталога приходит по сети — не доверяем форме, проверяем поля. */
export function parseCatalogTicketInfo(raw: unknown): CatalogTicketInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const strings = ['eventTitle', 'startsAt', 'venueName', 'venueCity', 'venueAddress'] as const;
  for (const key of strings) {
    if (typeof r[key] !== 'string') return null;
  }
  if (typeof r.seatRow !== 'number' || typeof r.seatNumber !== 'number') return null;
  if (r.seatSection !== null && typeof r.seatSection !== 'string') return null;
  if (Number.isNaN(Date.parse(r.startsAt as string))) return null;

  return {
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
