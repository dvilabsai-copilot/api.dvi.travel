import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createConnection } from 'mysql2/promise';

/** The engine uses autocommit writes, so its lock must outlive each statement. */
export async function withVehicleRebuildLock<T>(
  planId: number, work: () => Promise<T>, connect = createConnection,
): Promise<T> {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) throw new ServiceUnavailableException('Vehicle rebuild lock is unavailable');
  const databaseKey = createHash('sha256').update(new URL(url).pathname).digest('hex').slice(0,16);
  const name = `dvi:vehicle:${databaseKey}:${planId}`;
  const connection = await connect(url);
  let acquired = false;
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [name]);
    acquired = Number((rows as any)?.[0]?.acquired) === 1;
    if (!acquired) throw new ServiceUnavailableException('Another vehicle rebuild is in progress. Please retry.');
    return await work();
  } finally {
    if (acquired) {
      try { await connection.query('SELECT RELEASE_LOCK(?)', [name]); } catch { /* Closing releases session locks. */ }
    }
    await connection.end();
  }
}
