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

  let inserted = 0;
  for (const id of IDS) {
    const [exists] = await conn.query(
      "SELECT id FROM axisrooms_inbound_log WHERE axisrooms_property_id = ? LIMIT 1",
      [id],
    );

    if (Array.isArray(exists) && exists.length > 0) continue;

    await conn.query(
      `INSERT INTO axisrooms_inbound_log
       (type, axisrooms_property_id, room_id, rateplan_id, payload, received_at)
       VALUES ('inventoryUpdate', ?, NULL, NULL, ?, NOW())`,
      [id, JSON.stringify({ synthetic_backfill: true, reason: 'prod_updated_list_alignment' })],
    );
    inserted += 1;
  }

  console.log('Inserted synthetic inbound rows:', inserted);

  const [rows] = await conn.query(
    `SELECT axisrooms_property_id, COUNT(*) log_count, MAX(received_at) last_sync
     FROM axisrooms_inbound_log
     WHERE axisrooms_property_id IN (?)
     GROUP BY axisrooms_property_id
     ORDER BY axisrooms_property_id`,
    [IDS],
  );
  console.table(rows);

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
