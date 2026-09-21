import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// Клиентский id принимаем, только если он безопасен для логов и заголовков: длина и
// алфавит ограничены, иначе выдаём свой. Иначе туда можно записать что угодно.
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Сквозной идентификатор запроса: возвращается клиенту в `x-request-id` (его можно
 * сообщить в поддержку) и уходит в сервисы тем же заголовком (прокси пересылает
 * заголовки запроса как есть), чтобы одну и ту же операцию находить по всем логам.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}
