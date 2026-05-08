/**
 * Generic AxisRooms production -> local sync by property id.
 *
 * Usage:
 *   node scripts/sync-prod-axisrooms-properties-to-local.js AX_DVI_HOTEL_101 AX_DVI_HOTEL_153
 *
 * Optional env vars:
 *   PROD_SSH_HOST=root@134.209.145.185
 *   PROD_APP_DIR=/var/www/api.dvi.travel
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const LOCAL_DB_URL = process.env.DATABASE_URL || '';
const PROD_DB_URL = process.env.PROD_DATABASE_URL || '';

const propertyIds = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);

if (!LOCAL_DB_URL) {
  console.error('Missing local DATABASE_URL');
  process.exit(1);
}

if (!PROD_DB_URL) {
  console.error('Missing PROD_DATABASE_URL');
  process.exit(1);
}

if (!propertyIds.length) {
  console.error('Usage: node scripts/sync-prod-axisrooms-properties-to-local.js <PROPERTY_ID...>');
  process.exit(1);
}

function jsonVal(v) {
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

function upsertSql(table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.map((c) => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');
  return {
    sql: `INSERT INTO \`${table}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    values: Object.values(row).map(jsonVal),
  };
}

async function upsertRows(conn, table, rows) {
  if (!rows || !rows.length) return 0;
  for (const row of rows) {
    const { sql, values } = upsertSql(table, row);
    await conn.query(sql, values);
  }
  return rows.length;
}

async function deleteAndInsert(conn, table, opts) {
  const {
    rows,
    hotelCol,
    hotelId,
    propertyCol,
    propertyId,
    skipPk,
  } = opts;

  if (!rows || !rows.length) return 0;

  if (hotelCol) {
    await conn.query(`DELETE FROM \`${table}\` WHERE \`${hotelCol}\`=?`, [hotelId]);
  } else if (propertyCol) {
    await conn.query(`DELETE FROM \`${table}\` WHERE \`${propertyCol}\`=?`, [propertyId]);
  }

  for (const row of rows) {
    const entries = Object.entries(row).filter(([k]) => !skipPk || k !== skipPk);
    const cols = entries.map(([k]) => k);
    const placeholders = cols.map(() => '?').join(', ');
    const values = entries.map(([, v]) => jsonVal(v));
    await conn.query(`INSERT INTO \`${table}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders})`, values);
  }

  return rows.length;
}

async function safeQuery(conn, sql, params) {
  try {
    const [rows] = await conn.query(sql, params || []);
    return JSON.parse(JSON.stringify(rows, (k, v) => (v instanceof Date ? v.toISOString() : v)));
  } catch (_) {
    return [];
  }
}

async function fetchProdDumpFromDb(prodConn, propertyId) {
  const hotelRows = await safeQuery(
    prodConn,
    'SELECT * FROM dvi_hotel WHERE axisrooms_property_id = ? LIMIT 1',
    [propertyId],
  );
  const hotel = hotelRows[0];
  if (!hotel) {
    return { error: 'hotel_not_found', propertyId };
  }

  const hotelId = Number(hotel.hotel_id);
  const rooms = await safeQuery(
    prodConn,
    'SELECT * FROM dvi_hotel_rooms WHERE hotel_id=? AND deleted=0 ORDER BY room_ID',
    [hotelId],
  );
  const rp = await safeQuery(
    prodConn,
    'SELECT * FROM dvi_hotel_room_rate_plan WHERE hotel_id=? AND deleted=0 ORDER BY room_id, rateplan_id',
    [hotelId],
  );
  const occ = await safeQuery(
    prodConn,
    'SELECT * FROM dvi_hotel_occupancy_rate WHERE hotel_id=? ORDER BY room_id, rateplan_id, start_date',
    [hotelId],
  );
  const avail = await safeQuery(
    prodConn,
    'SELECT * FROM dvi_hotel_room_availability WHERE hotel_id=? ORDER BY room_id, start_date',
    [hotelId],
  );

  const axRooms = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_room WHERE axisrooms_property_id=? ORDER BY room_id',
    [propertyId],
  );
  const axRp = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_rateplan WHERE axisrooms_property_id=? ORDER BY room_id, rateplan_id',
    [propertyId],
  );
  const axInv = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_inventory WHERE axisrooms_property_id=? ORDER BY room_id, start_date',
    [propertyId],
  );
  const axRate = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_rate WHERE axisrooms_property_id=? ORDER BY room_id, rateplan_id, start_date',
    [propertyId],
  );
  const axRest = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_restriction WHERE axisrooms_property_id=? ORDER BY room_id, start_date',
    [propertyId],
  );
  const axInbound = await safeQuery(
    prodConn,
    'SELECT * FROM axisrooms_inbound_log WHERE axisrooms_property_id=? ORDER BY received_at, id',
    [propertyId],
  );

  return {
    hotel,
    rooms,
    rp,
    occ,
    avail,
    ax_rooms: axRooms,
    ax_rp: axRp,
    ax_inv: axInv,
    ax_rate: axRate,
    ax_rest: axRest,
    ax_inbound: axInbound,
  };
}

async function syncOneProperty(localConn, prodConn, propertyId) {
  const dump = await fetchProdDumpFromDb(prodConn, propertyId);
  if (!dump || dump.error) {
    const msg = dump && dump.error ? `${dump.error} (${propertyId})` : `No dump for ${propertyId}`;
    throw new Error(msg);
  }

  const hotelId = Number(dump.hotel.hotel_id);
  await localConn.query('START TRANSACTION');
  try {
    const summary = {
      propertyId,
      hotelId,
      hotelName: String(dump.hotel.hotel_name || ''),
    };

    summary.hotel = await upsertRows(localConn, 'dvi_hotel', [dump.hotel]);
    summary.rooms = await deleteAndInsert(localConn, 'dvi_hotel_rooms', {
      rows: dump.rooms,
      hotelCol: 'hotel_id',
      hotelId,
    });
    summary.ratePlans = await deleteAndInsert(localConn, 'dvi_hotel_room_rate_plan', {
      rows: dump.rp,
      hotelCol: 'hotel_id',
      hotelId,
      skipPk: 'hotel_room_rate_plan_id',
    });
    summary.occupancy = await deleteAndInsert(localConn, 'dvi_hotel_occupancy_rate', {
      rows: dump.occ,
      hotelCol: 'hotel_id',
      hotelId,
      skipPk: 'id',
    });
    summary.availability = await deleteAndInsert(localConn, 'dvi_hotel_room_availability', {
      rows: dump.avail,
      hotelCol: 'hotel_id',
      hotelId,
      skipPk: 'id',
    });

    summary.axInventory = await deleteAndInsert(localConn, 'axisrooms_inventory', {
      rows: dump.ax_inv,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });
    summary.axRestriction = await deleteAndInsert(localConn, 'axisrooms_restriction', {
      rows: dump.ax_rest,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });
    summary.axInbound = await deleteAndInsert(localConn, 'axisrooms_inbound_log', {
      rows: dump.ax_inbound,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });
    summary.axRooms = await deleteAndInsert(localConn, 'axisrooms_room', {
      rows: dump.ax_rooms,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });
    summary.axRateplan = await deleteAndInsert(localConn, 'axisrooms_rateplan', {
      rows: dump.ax_rp,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });
    summary.axRate = await deleteAndInsert(localConn, 'axisrooms_rate', {
      rows: dump.ax_rate,
      propertyCol: 'axisrooms_property_id',
      propertyId,
      skipPk: 'id',
    });

    await localConn.query('COMMIT');
    return summary;
  } catch (e) {
    await localConn.query('ROLLBACK');
    throw e;
  }
}

(async () => {
  const localConn = await mysql.createConnection(LOCAL_DB_URL);
  const prodConn = await mysql.createConnection(PROD_DB_URL);
  const report = [];
  try {
    for (const propertyId of propertyIds) {
      process.stdout.write(`\nSyncing ${propertyId}...\n`);
      const summary = await syncOneProperty(localConn, prodConn, propertyId);
      report.push(summary);
      process.stdout.write(`  done: hotel_id=${summary.hotelId}, rooms=${summary.rooms}, occupancy=${summary.occupancy}, availability=${summary.availability}\n`);
    }

    process.stdout.write('\nSync complete for all requested properties.\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    await localConn.end();
    await prodConn.end();
  }
})().catch((e) => {
  console.error('SYNC ERROR:', e.message || String(e));
  process.exit(1);
});
