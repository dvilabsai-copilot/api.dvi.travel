const fs = require('fs');
const path = require('path');
require('dotenv').config();
const mysql = require('mysql2/promise');

function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  return value;
}

function normalizeRows(rows, omitKeys = []) {
  return rows
    .map((row) => {
      const out = {};
      for (const key of Object.keys(row).sort()) {
        if (omitKeys.includes(key)) continue;
        out[key] = stable(row[key]);
      }
      return out;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

(async () => {
  const dump = JSON.parse(fs.readFileSync(path.join(__dirname, 'prod_ax153_dump.json'), 'utf8'));
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const checks = [
    ['dvi_hotel', dump.hotel ? [dump.hotel] : [], 'SELECT * FROM dvi_hotel WHERE hotel_id=153', []],
    ['dvi_hotel_rooms', dump.rooms, 'SELECT * FROM dvi_hotel_rooms WHERE hotel_id=153 AND deleted=0', []],
    ['dvi_hotel_room_rate_plan', dump.rp, 'SELECT * FROM dvi_hotel_room_rate_plan WHERE hotel_id=153 AND deleted=0', ['hotel_room_rate_plan_id']],
    ['dvi_hotel_occupancy_rate', dump.occ, 'SELECT * FROM dvi_hotel_occupancy_rate WHERE hotel_id=153', ['id']],
    ['dvi_hotel_room_availability', dump.avail, 'SELECT * FROM dvi_hotel_room_availability WHERE hotel_id=153', ['id']],
    ['axisrooms_inventory', dump.ax_inv, "SELECT * FROM axisrooms_inventory WHERE axisrooms_property_id='AX_DVI_HOTEL_153'", ['id']],
    ['axisrooms_restriction', dump.ax_rest, "SELECT * FROM axisrooms_restriction WHERE axisrooms_property_id='AX_DVI_HOTEL_153'", ['id']],
    ['axisrooms_room', dump.ax_rooms, "SELECT * FROM axisrooms_room WHERE axisrooms_property_id='AX_DVI_HOTEL_153'", ['id']],
    ['axisrooms_rateplan', dump.ax_rp, "SELECT * FROM axisrooms_rateplan WHERE axisrooms_property_id='AX_DVI_HOTEL_153'", ['id']],
    ['axisrooms_rate', dump.ax_rate, "SELECT * FROM axisrooms_rate WHERE axisrooms_property_id='AX_DVI_HOTEL_153'", ['id']],
  ];

  let allMatch = true;
  for (const [label, prodRows, sql, omit] of checks) {
    const [localRows] = await conn.query(sql);
    const prodNorm = normalizeRows(prodRows, omit);
    const localNorm = normalizeRows(localRows, omit);
    const match = JSON.stringify(prodNorm) === JSON.stringify(localNorm);
    if (!match) allMatch = false;
    console.log(`${label}: ${match ? 'MATCH' : 'DIFF'} | prod=${prodNorm.length} local=${localNorm.length}`);
    if (!match) {
      const prodOnly = prodNorm.find((row) => !localNorm.some((x) => JSON.stringify(x) === JSON.stringify(row))) || null;
      const localOnly = localNorm.find((row) => !prodNorm.some((x) => JSON.stringify(x) === JSON.stringify(row))) || null;
      console.log(`  prod_only_sample=${JSON.stringify(prodOnly)}`);
      console.log(`  local_only_sample=${JSON.stringify(localOnly)}`);
    }
  }

  console.log(`OVERALL: ${allMatch ? 'PARITY' : 'NOT_IN_PARITY'}`);
  await conn.end();
})().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});
