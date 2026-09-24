import { PrismaService } from './prisma.service';

// Реальный Postgres (как остальные integration.spec.ts): проверяем не арифметику адреса,
// а то, что пул действительно ограничен — сколько запросов одновременно исполняется в базе.
process.env.PAYMENT_DATABASE_URL ??=
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=payment';

/** Максимум одновременно исполняющихся в базе запросов с нашей меткой за время прогона. */
async function peakConcurrency(poolSize: string | undefined, queries: number): Promise<number> {
  const previous = process.env.DB_POOL_SIZE;
  if (poolSize === undefined) delete process.env.DB_POOL_SIZE;
  else process.env.DB_POOL_SIZE = poolSize;
  const worker = new PrismaService();
  // Наблюдатель со своим большим пулом, чтобы замер не конкурировал с проверяемым клиентом.
  process.env.DB_POOL_SIZE = '20';
  const observer = new PrismaService();
  if (previous === undefined) delete process.env.DB_POOL_SIZE;
  else process.env.DB_POOL_SIZE = previous;

  await worker.$connect();
  await observer.$connect();
  try {
    const marker = `poolprobe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const running = Array.from({ length: queries }, () =>
      worker.$queryRawUnsafe(`select pg_sleep(0.4)::text /* ${marker} */`),
    );

    let peak = 0;
    const sampler = (async () => {
      for (let i = 0; i < 20; i += 1) {
        const rows = await observer.$queryRawUnsafe<{ n: bigint }[]>(
          `select count(*) as n from pg_stat_activity
           where state = 'active' and query like '%${marker}%' and pid <> pg_backend_pid()`,
        );
        peak = Math.max(peak, Number(rows[0].n));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    await Promise.all([...running, sampler]);
    return peak;
  } finally {
    await worker.$disconnect();
    await observer.$disconnect();
  }
}

describe('пул соединений Prisma (реальный Postgres)', () => {
  jest.setTimeout(30_000);

  it('DB_POOL_SIZE=3 — в базе одновременно не больше трёх запросов', async () => {
    const peak = await peakConcurrency('3', 12);

    expect(peak).toBeLessThanOrEqual(3);
    // Пул при этом реально используется параллельно, а не запросы идут по одному.
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  it('по умолчанию — не больше 5, независимо от числа ядер машины (у Prisma там cpu×2+1)', async () => {
    const peak = await peakConcurrency(undefined, 40);

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThanOrEqual(3);
  });
});
