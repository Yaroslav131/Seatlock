import { Client } from 'pg';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ??
  'postgresql://seatlock:seatlock@localhost:5433/seatlock?schema=auth';

/**
 * В интерфейсе нет способа стать организатором — это осознанное
 * решение продукта, не забытая фича (см. RegisterDto: role всегда
 * USER). Единственный способ провести e2e-сценарий организатора —
 * прямой доступ к Postgres в обход API/UI, как это делал бы
 * реальный админ вручную.
 */
export async function promoteToOrganizer(email: string): Promise<void> {
  const client = new Client({ connectionString: AUTH_DATABASE_URL });
  await client.connect();
  try {
    // node-postgres не понимает ?schema= в connection string — это чисто
    // Prisma-соглашение (см. ADR 0001), само по себе на плагине pg никак
    // не сказывается. Таблица явно квалифицирована схемой auth.
    const result = await client.query('UPDATE auth.users SET role = $1 WHERE email = $2', [
      'ORGANIZER',
      email,
    ]);
    if (result.rowCount === 0) {
      throw new Error(`не нашла пользователя с email=${email}, чтобы повысить до ORGANIZER`);
    }
  } finally {
    await client.end();
  }
}
