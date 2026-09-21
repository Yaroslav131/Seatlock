/**
 * Оборвал ли запрос `AbortSignal.timeout()`. Проверка по имени, а не по instanceof:
 * DOMException от fetch не всегда наследует Error того же realm (так бывает в jest),
 * и instanceof тихо превращал бы таймаут в обычную ошибку соединения.
 */
export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TimeoutError'
  );
}
