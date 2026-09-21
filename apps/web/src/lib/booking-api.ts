import { authFetch } from './api-client';

export interface Hold {
  seatId: string;
  expiresAt: string;
}

export function holdSeat(eventId: string, seatId: string): Promise<Hold> {
  return authFetch<Hold>(`/api/booking/events/${eventId}/holds`, {
    method: 'POST',
    body: JSON.stringify({ seatId }),
  });
}

export function releaseHold(eventId: string): Promise<void> {
  return authFetch<void>(`/api/booking/events/${eventId}/holds`, { method: 'DELETE' });
}
