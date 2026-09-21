import { authFetch, publicFetch } from './api-client';
import type { Hold } from './booking-api';

export interface SeatStatusResponse {
  held: { seatId: string }[];
  sold: { seatId: string }[];
  myHold: Hold | null;
}

/**
 * Состояние карты мест одним запросом (gateway собирает его из booking и payment):
 * раньше карта делала при каждом опросе три отдельных.
 *
 * С токеном ответ содержит и собственный холд, а просроченный токен обновляется
 * обычным путём authFetch. `fresh` просит обойти секундный кеш gateway: нужен сразу
 * после собственного действия (занял/отпустил), иначе только что отпущенное место
 * до следующего опроса выглядело бы занятым.
 */
export function getSeatStatus(
  eventId: string,
  options: { authenticated: boolean; fresh?: boolean },
): Promise<SeatStatusResponse> {
  const path = `/api/events/${eventId}/seat-status${options.fresh ? '?fresh=1' : ''}`;
  return options.authenticated
    ? authFetch<SeatStatusResponse>(path)
    : publicFetch<SeatStatusResponse>(path);
}
