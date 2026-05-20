require('dotenv').config();
const mysql = require('mysql2/promise');

const IDS = [
  'AX_DVI_HOTEL_10',
  'AX_DVI_HOTEL_95',
  'AX_DVI_HOTEL_101',
  'AX_DVI_HOTEL_153',
  'AX_DVI_HOTEL_194',
  'AX_DVI_HOTEL_233',
  'AX_DVI_HOTEL_237',
  'AX_DVI_HOTEL_238',
  'AX_DVI_HOTEL_248',
  'AX_DVI_HOTEL_249',
  'AX_DVI_HOTEL_250',
  'AX_DVI_HOTEL_411',
  'AX_DVI_HOTEL_416',
  'AX_DVI_HOTEL_417',
  'AX_DVI_HOTEL_433',
  'AX_DVI_HOTEL_459',
];

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [rows] = await conn.query(
    `SELECT axisrooms_property_id, COUNT(*) AS log_count, MAX(received_at) AS last_sync
     FROM axisrooms_inbound_log
     WHERE axisrooms_property_id IN (?)
     GROUP BY axisrooms_property_id
     ORDER BY axisrooms_property_id`,
    [IDS],
  );

  const existing = new Set(rows.map((r) => String(r.axisrooms_property_id)));
  const missing = IDS.filter((id) => !existing.has(id));

  console.log('Existing in local inbound log:', rows.length);
  console.table(rows);
  console.log('Missing in local inbound log:', missing.length);
  console.table(missing.map((m) => ({ axisrooms_property_id: m })));

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
