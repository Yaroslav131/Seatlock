import { ConfigService } from '@nestjs/config';
import { readPrefetch } from './prefetch';

function configWith(value: string | number | undefined): ConfigService {
  return { get: jest.fn(() => value) } as unknown as ConfigService;
}

describe('readPrefetch', () => {
  it.each([[undefined], ['']])('не задан (%p) — 1, как раньше', (value) => {
    expect(readPrefetch(configWith(value))).toBe(1);
  });

  it('читает число из строки окружения', () => {
    expect(readPrefetch(configWith('4'))).toBe(4);
    expect(readPrefetch(configWith(3))).toBe(3);
  });

  it.each([['0'], ['-1'], ['2.5'], ['abc'], ['51']])('%s — ошибка на старте', (value) => {
    expect(() => readPrefetch(configWith(value))).toThrow('NOTIFICATION_PREFETCH');
  });
});
