import { authFetch, publicFetch } from './api-client';

export type OrderStatus = 'PENDING' | 'PAID' | 'CANCELLED' | 'REFUNDED';

export interface Order {
  id: string;
  eventId: string;
  seatId: string;
  amountCents: number;
  status: OrderStatus;
  providerIntentId: string | null;
}

export interface CreateOrderResponse extends Order {
  clientSecret: string;
}

export function createOrder(eventId: string, seatId: string): Promise<CreateOrderResponse> {
  return authFetch<CreateOrderResponse>('/api/payment/orders', {
    method: 'POST',
    body: JSON.stringify({ eventId, seatId }),
  });
}

// Без JWT-гварда на бэке (это имитация вебхука провайдера, не действие
// пользователя, см. payment-webhook.controller.ts) — publicFetch, а не authFetch.
export function confirmFakePayment(providerIntentId: string): Promise<{ received: true }> {
  return publicFetch<{ received: true }>('/api/payment/dev/fake-webhook', {
    method: 'POST',
    body: JSON.stringify({ providerIntentId, type: 'payment.succeeded' }),
  });
}

// Публично, для карты зала — тот же принцип, что и getHeldSeats в booking-api.ts.
export function getSoldSeats(eventId: string): Promise<{ seatId: string }[]> {
  return publicFetch<{ seatId: string }[]>(`/api/payment/events/${eventId}/sold-seats`);
}

// ORGANIZER/ADMIN — бэк сам проверяет, что событие принадлежит вызывающему.
export function listOrders(eventId: string): Promise<Order[]> {
  return authFetch<Order[]>(`/api/payment/orders?eventId=${eventId}`);
}

export function refundOrder(orderId: string): Promise<Order> {
  return authFetch<Order>(`/api/payment/orders/${orderId}/refund`, { method: 'PATCH' });
}
