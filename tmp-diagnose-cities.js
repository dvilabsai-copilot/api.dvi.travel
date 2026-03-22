require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function run() {
  // Full state of dvi_cities
  const summary = await p.$queryRawUnsafe(
    `SELECT
       COUNT(*) AS total,
       SUM(deleted = 0) AS active,
       SUM(deleted = 1) AS soft_deleted,
       SUM(deleted IS NULL) AS null_deleted,
       SUM(tbo_city_code IS NOT NULL AND tbo_city_code != '') AS has_tbo_code
     FROM dvi_cities`
  );
  const s = summary[0];
  console.log('dvi_cities summary:', JSON.stringify({
    total: Number(s.total),
    active: Number(s.active),
    soft_deleted: Number(s.soft_deleted),
    null_deleted: Number(s.null_deleted),
    has_tbo_code: Number(s.has_tbo_code),
  }));

  // Sample any rows that exist
  const sample = await p.$queryRawUnsafe(
    `SELECT id, name, state_id, tbo_city_code, status, deleted FROM dvi_cities LIMIT 10`
  );
  console.log('Sample rows:', JSON.stringify(sample.map(r => ({
    id: Number(r.id), name: r.name, tbo_city_code: r.tbo_city_code,
    status: Number(r.status), deleted: Number(r.deleted)
  }))));

  // Check if Madurai / Thanjavur / Mahabalipuram exist at all (regardless of deleted)
  for (const city of ['Madurai', 'Thanjavur', 'Mahabalipuram']) {
    const rows = await p.$queryRawUnsafe(
      `SELECT id, name, tbo_city_code, deleted FROM dvi_cities WHERE name LIKE ? LIMIT 5`,
      `%${city}%`
    );
    console.log(`dvi_cities LIKE '${city}':`, JSON.stringify(rows.map(r => ({ id: Number(r.id), name: r.name, tbo_city_code: r.tbo_city_code, deleted: Number(r.deleted) }))));
  }
}
run().catch(e => console.error(e.message)).finally(() => p.$disconnect());

