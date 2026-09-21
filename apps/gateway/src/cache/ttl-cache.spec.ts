import { TtlCache } from './ttl-cache';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TtlCache', () => {
  let time: number;
  let cache: TtlCache<string>;
  const ok = (value: string) => () => Promise.resolve({ value, cacheable: true });

  beforeEach(() => {
    time = 1_000;
    cache = new TtlCache<string>(3, () => time);
  });

  it('второй запрос в пределах TTL берётся из кеша, loader не вызывается', async () => {
    const loader = jest.fn(ok('a'));
    expect(await cache.get('k', 1000, loader)).toEqual({ value: 'a', source: 'miss' });
    time += 999;
    expect(await cache.get('k', 1000, loader)).toEqual({ value: 'a', source: 'hit' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('после TTL значение запрашивается заново', async () => {
    const loader = jest
      .fn()
      .mockResolvedValueOnce({ value: 'a', cacheable: true })
      .mockResolvedValueOnce({ value: 'b', cacheable: true });
    await cache.get('k', 1000, loader);
    time += 1000;
    expect((await cache.get('k', 1000, loader)).value).toBe('b');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('cacheable: false отдаётся, но не запоминается', async () => {
    const loader = jest.fn().mockResolvedValue({ value: 'err', cacheable: false });
    await cache.get('k', 1000, loader);
    await cache.get('k', 1000, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('одновременные запросы одного ключа объединяются в один вызов loader', async () => {
    const gate = deferred<{ value: string; cacheable: boolean }>();
    const loader = jest.fn(() => gate.promise);

    const first = cache.get('k', 1000, loader);
    const second = cache.get('k', 1000, loader);
    const third = cache.get('k', 1000, loader);
    gate.resolve({ value: 'shared', cacheable: true });

    expect(await first).toEqual({ value: 'shared', source: 'miss' });
    expect(await second).toEqual({ value: 'shared', source: 'coalesced' });
    expect(await third).toEqual({ value: 'shared', source: 'coalesced' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('ошибка loader достаётся всем ожидающим и не запоминается: следующий запрос пробует снова', async () => {
    const gate = deferred<{ value: string; cacheable: boolean }>();
    const loader = jest.fn(() => gate.promise);
    const first = cache.get('k', 1000, loader);
    const second = cache.get('k', 1000, loader);
    gate.reject(new Error('сервис лёг'));

    await expect(first).rejects.toThrow('сервис лёг');
    await expect(second).rejects.toThrow('сервис лёг');
    expect(loader).toHaveBeenCalledTimes(1);

    const retry = jest.fn(ok('ожил'));
    expect((await cache.get('k', 1000, retry)).value).toBe('ожил');
  });

  it('не хранит больше maxEntries: вытесняет самые старые', async () => {
    for (const key of ['a', 'b', 'c', 'd']) {
      await cache.get(key, 10_000, ok(key));
    }
    expect(cache.size).toBe(3);
    expect((await cache.get('a', 10_000, ok('a2'))).source).toBe('miss');
  });

  it('при вытеснении сначала убираются протухшие записи', async () => {
    await cache.get('old', 100, ok('old'));
    time += 500;
    await cache.get('b', 10_000, ok('b'));
    await cache.get('c', 10_000, ok('c'));
    await cache.get('d', 10_000, ok('d'));

    expect(cache.size).toBe(3);
    expect((await cache.get('b', 10_000, ok('x'))).source).toBe('hit');
  });
});
