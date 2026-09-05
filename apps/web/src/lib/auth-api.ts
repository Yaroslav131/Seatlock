import { authFetch, publicFetch } from './api-client';

interface TokenResponse {
  accessToken: string;
}

export interface MeResponse {
  sub: string;
  email: string;
  role: 'USER' | 'ORGANIZER' | 'ADMIN';
  iat: number;
  exp: number;
}

export function register(email: string, password: string): Promise<TokenResponse> {
  return publicFetch<TokenResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function login(email: string, password: string): Promise<TokenResponse> {
  return publicFetch<TokenResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<void> {
  return authFetch<void>('/api/auth/logout', { method: 'POST' });
}

export function fetchMe(): Promise<MeResponse> {
  return authFetch<MeResponse>('/api/me');
}
