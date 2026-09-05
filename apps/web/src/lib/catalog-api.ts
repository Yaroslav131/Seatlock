import { authFetch, publicFetch } from './api-client';

export interface Venue {
  id: string;
  name: string;
  city: string;
  address: string;
  seatCount: number;
}

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED';

export interface Event {
  id: string;
  venueId: string;
  organizerId: string;
  title: string;
  description: string | null;
  startsAt: string;
  basePriceCents: number;
  status: EventStatus;
}

export function listPublishedEvents(): Promise<Event[]> {
  return publicFetch<Event[]>('/api/catalog/events');
}

export function getEvent(id: string): Promise<Event> {
  return publicFetch<Event>(`/api/catalog/events/${id}`);
}

export function getVenue(id: string): Promise<Venue> {
  return publicFetch<Venue>(`/api/catalog/venues/${id}`);
}

export function listVenues(): Promise<Venue[]> {
  return publicFetch<Venue[]>('/api/catalog/venues');
}

export function listMyEvents(): Promise<Event[]> {
  return authFetch<Event[]>('/api/catalog/events/mine');
}

export interface CreateVenueInput {
  name: string;
  city: string;
  address: string;
}

export function createVenue(input: CreateVenueInput): Promise<Venue> {
  return authFetch<Venue>('/api/catalog/venues', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function generateSeats(
  venueId: string,
  input: { rows: number; seatsPerRow: number; section?: string },
): Promise<{ created: number }> {
  return authFetch<{ created: number }>(`/api/catalog/venues/${venueId}/seats/generate`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export interface CreateEventInput {
  venueId: string;
  title: string;
  description?: string;
  startsAt: string;
  basePriceCents: number;
}

export function createEvent(input: CreateEventInput): Promise<Event> {
  return authFetch<Event>('/api/catalog/events', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function publishEvent(id: string): Promise<Event> {
  return authFetch<Event>(`/api/catalog/events/${id}/publish`, { method: 'PATCH' });
}
