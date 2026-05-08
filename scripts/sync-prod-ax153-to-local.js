/**
 * sync-prod-ax153-to-local.js
 * Reads prod_ax153_dump.json and upserts all data into local DB.
 * Safe to re-run (idempotent).
 * Usage: node scripts/sync-prod-ax153-to-local.js
 */
require('dotenv').config();
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const DUMP_PATH = path.join(__dirname, 'prod_ax153_dump.json');
const LOCAL_DB_URL = process.env.DATABASE_URL;

// Helper: build an INSERT ... ON DUPLICATE KEY UPDATE statement
function upsertSql(table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');
  const values = Object.values(row).map(v => (Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))) ? JSON.stringify(v) : v);
  return {
    sql: `INSERT INTO \`${table}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    values,
  };
}

async function upsertRows(conn, table, rows, label) {
  if (!rows || rows.length === 0) { console.log(`  ${label}: 0 rows (skip)`); return; }
  let count = 0;
  for (const row of rows) {
    const { sql, values } = upsertSql(table, row);
    try {
      await conn.query(sql, values);
    } catch (e) {
      console.error(`  ERROR in ${table} row ${count}:`, e.message);
      throw e;
    }
    count++;
  }
  console.log(`  ${label}: ${count} rows upserted into ${table}`);
}

async function deleteAndInsert(conn, table, hotel_col, hotelId, rows, label, property_col, skipPk) {
  if (!rows || rows.length === 0) { console.log(`  ${label}: 0 rows (skip)`); return; }
  if (hotel_col) {
    await conn.query(`DELETE FROM \`${table}\` WHERE \`${hotel_col}\`=?`, [hotelId]);
  } else if (property_col) {
    await conn.query(`DELETE FROM \`${table}\` WHERE \`${property_col}\`=?`, ['AX_DVI_HOTEL_153']);
  }
  let count = 0;
  for (const row of rows) {
    const entries = Object.entries(row).filter(([k]) => !skipPk || k !== skipPk);
    const cols = entries.map(([k]) => k);
    const placeholders = cols.map(() => '?').join(', ');
    const values = entries.map(([, v]) => (Array.isArray(v) || (v !== null && typeof v === 'object' && !(v instanceof Date))) ? JSON.stringify(v) : v);
    await conn.query(`INSERT INTO \`${table}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders})`, values);
    count++;
  }
  console.log(`  ${label}: deleted+inserted ${count} rows into ${table}`);
}

(async () => {
  const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
  const conn = await mysql.createConnection(LOCAL_DB_URL);

  try {
    console.log(`Syncing hotel_id=${dump.hotel.hotel_id} (${dump.hotel.hotel_name}) to local...`);
    const hotelId = dump.hotel.hotel_id;

    // 1. dvi_hotel
    await upsertRows(conn, 'dvi_hotel', [dump.hotel], 'hotel');

    // 2. dvi_hotel_rooms (keep room_ID so foreign references work)
    await deleteAndInsert(conn, 'dvi_hotel_rooms', 'hotel_id', hotelId, dump.rooms, 'rooms', null, null);

    // 3. dvi_hotel_room_rate_plan
    await deleteAndInsert(conn, 'dvi_hotel_room_rate_plan', 'hotel_id', hotelId, dump.rp, 'rate_plans', null, 'hotel_room_rate_plan_id');

    // 4. dvi_hotel_occupancy_rate
    await deleteAndInsert(conn, 'dvi_hotel_occupancy_rate', 'hotel_id', hotelId, dump.occ, 'occupancy_rates', null, 'id');

    // 5. dvi_hotel_room_availability
    await deleteAndInsert(conn, 'dvi_hotel_room_availability', 'hotel_id', hotelId, dump.avail, 'availability', null, 'id');

    // 6. axisrooms_inventory (audit log)
    await deleteAndInsert(conn, 'axisrooms_inventory', null, null, dump.ax_inv, 'ax_inventory', 'axisrooms_property_id', 'id');

    // 7. axisrooms_restriction
    await deleteAndInsert(conn, 'axisrooms_restriction', null, null, dump.ax_rest, 'ax_restriction', 'axisrooms_property_id', 'id');

    // 8. axisrooms_room / axisrooms_rateplan / axisrooms_rate (dead tables - skip if empty)
    await deleteAndInsert(conn, 'axisrooms_room', null, null, dump.ax_rooms, 'ax_rooms', 'axisrooms_property_id', 'id');
    await deleteAndInsert(conn, 'axisrooms_rateplan', null, null, dump.ax_rp, 'ax_rateplan', 'axisrooms_property_id', 'id');
    await deleteAndInsert(conn, 'axisrooms_rate', null, null, dump.ax_rate, 'ax_rate', 'axisrooms_property_id', 'id');

    console.log('\nSync complete.');
  } finally {
    await conn.end();
  }
})().catch(e => {
  console.error('SYNC ERROR:', e.message || String(e));
  process.exit(1);
});
