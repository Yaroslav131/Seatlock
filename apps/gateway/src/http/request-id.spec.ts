import type { Request, Response } from 'express';
import { requestIdMiddleware } from './request-id';

function run(incoming?: string | string[]) {
  const req = { headers: incoming === undefined ? {} : { 'x-request-id': incoming } } as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  const next = jest.fn();
  requestIdMiddleware(req, res, next);
  return { req, res, next };
}

describe('requestIdMiddleware', () => {
  it('без заголовка выдаёт новый UUID и в запрос (для сервисов), и в ответ (для клиента)', () => {
    const { req, res, next } = run();
    const id = req.headers['x-request-id'] as string;

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('безопасный клиентский id сохраняется', () => {
    const { req } = run('client-req_123.abc');
    expect(req.headers['x-request-id']).toBe('client-req_123.abc');
  });

  it.each([
    ['слишком короткий', 'abc'],
    ['слишком длинный', 'a'.repeat(65)],
    ['с пробелами и переводом строки', 'bad id\r\nx-evil: 1'],
    ['с недопустимыми символами', '<script>alert(1)</script>'],
    ['массив (заголовок повторён)', ['aaaaaaaa', 'bbbbbbbb']],
  ])('%s — заменяется на свой', (_name, incoming) => {
    const { req } = run(incoming);
    expect(req.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
