import { prismaOptions, readPoolSize, withPoolSettings } from './database-url';

describe('readPoolSize', () => {
  it.each([[undefined], [''], ['  ']])(
    'не задан (%p) — 5, как у Prisma на проде с 2 vCPU',
    (raw) => {
      expect(readPoolSize(raw)).toBe(5);
    },
  );

  it('читает число из строки окружения', () => {
    expect(readPoolSize('3')).toBe(3);
    expect(readPoolSize('50')).toBe(50);
  });

  it.each([['0'], ['-1'], ['2.5'], ['abc'], ['51']])('%s — ошибка на старте', (raw) => {
    expect(() => readPoolSize(raw)).toThrow('DB_POOL_SIZE');
  });
});

describe('withPoolSettings', () => {
  const base = 'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=payment';

  it('добавляет размер пула и время ожидания, не трогая остальное', () => {
    const url = new URL(withPoolSettings(base, 4));

    expect(url.searchParams.get('connection_limit')).toBe('4');
    expect(url.searchParams.get('pool_timeout')).toBe('10');
    expect(url.searchParams.get('schema')).toBe('payment');
    expect(url.username).toBe('seatlock');
    expect(url.password).toBe('seatlock');
    expect(url.host).toBe('localhost:5433');
    expect(url.pathname).toBe('/seatlock');
  });

  it('значения, уже указанные в самом адресе, не перезаписываются', () => {
    const url = new URL(withPoolSettings(`${base}&connection_limit=9&pool_timeout=3`, 4));

    expect(url.searchParams.get('connection_limit')).toBe('9');
    expect(url.searchParams.get('pool_timeout')).toBe('3');
  });

  it('пароль со спецсимволами не портится', () => {
    const raw = 'postgresql://seatlock:p%40ss%2Fw%3Ard@db:5432/seatlock?schema=payment';
    const url = new URL(withPoolSettings(raw, 5));

    expect(url.password).toBe('p%40ss%2Fw%3Ard');
    expect(url.host).toBe('db:5432');
  });
});

describe('prismaOptions', () => {
  const saved = process.env.DB_POOL_SIZE;
  afterEach(() => {
    if (saved === undefined) delete process.env.DB_POOL_SIZE;
    else process.env.DB_POOL_SIZE = saved;
  });

  it('адрес не задан — без переопределения (PrismaClient сообщит сам)', () => {
    expect(prismaOptions(undefined)).toBeUndefined();
    expect(prismaOptions('')).toBeUndefined();
  });

  it('размер пула берётся из DB_POOL_SIZE', () => {
    process.env.DB_POOL_SIZE = '7';
    const options = prismaOptions('postgresql://u:p@h:5432/d?schema=s');

    expect(new URL(options!.datasourceUrl).searchParams.get('connection_limit')).toBe('7');
  });
});
