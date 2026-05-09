// Query production (via SSH tunnel on 23307) for today's AxisRooms-updated hotels
// Usage: PROD_DATABASE_URL=... node scripts/query-axisrooms-hotels-today.js
const mysql = require('mysql2/promise');
const fs = require('fs');

async function main() {
  const url = process.env.PROD_DATABASE_URL;
  if (!url) { console.error('Set PROD_DATABASE_URL'); process.exit(1); }
  const conn = await mysql.createConnection(url);
  const [rows] = await conn.query(`
    SELECT h.hotel_id, h.hotel_name, h.axisrooms_property_id,
           COUNT(DISTINCT l.id) as sync_count
    FROM dvi_hotel h
    JOIN axisrooms_inbound_log l ON l.axisrooms_property_id = h.axisrooms_property_id
    WHERE h.axisrooms_property_id IS NOT NULL
    GROUP BY h.hotel_id ORDER BY h.hotel_id
  `);
  await conn.end();

  const csv = ['hotel_id,hotel_name,axisrooms_property_id,sync_count_today',
    ...rows.map(r => [r.hotel_id, JSON.stringify(r.hotel_name), r.axisrooms_property_id, r.sync_count].join(','))
  ].join('\n');

  const outFile = 'scripts/axisrooms-updated-hotels-today.csv';
  fs.writeFileSync(outFile, csv);
  console.log(csv);
  console.log(`\nSaved to ${outFile}`);
}
main().catch(console.error);
