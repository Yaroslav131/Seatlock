import { authFetch, publicFetch } from './api-client';

export interface Hold {
  seatId: string;
  expiresAt: string;
}

export function getHeldSeats(eventId: string): Promise<{ seatId: string }[]> {
  return publicFetch<{ seatId: string }[]>(`/api/booking/events/${eventId}/holds`);
}

export function getMyHold(eventId: string): Promise<Hold | null> {
  return authFetch<Hold | null>(`/api/booking/events/${eventId}/my-hold`);
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
