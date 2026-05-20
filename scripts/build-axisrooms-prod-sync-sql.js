const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const LOCAL_DB_URL = process.env.DATABASE_URL || '';
const PROD_DB_URL = process.env.PROD_DATABASE_URL || '';
const PROPERTY_ID = process.argv[2] || 'AX_DVI_HOTEL_153';

const REQUIRED_TABLES = [
  'dvi_hotel_rate_plan_master',
  'dvi_hotel_room_rate_plan',
  'dvi_hotel_occupancy_rate',
  'dvi_hotel_room_availability',
  'axisrooms_inventory',
  'axisrooms_restriction',
  'axisrooms_inbound_log',
];

const CANONICAL_RATEPLAN_IDS = new Set(['CP_PLAN', 'EP_PLAN', 'MAP_PLAN', 'AP_PLAN']);

if (!LOCAL_DB_URL) {
  console.error('Missing local DATABASE_URL');
  process.exit(1);
}
if (!PROD_DB_URL) {
  console.error('Missing PROD_DATABASE_URL env var');
  process.exit(1);
}

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') {
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  }
  if (v instanceof Date) {
    const yyyy = v.getFullYear();
    const mm = String(v.getMonth() + 1).padStart(2, '0');
    const dd = String(v.getDate()).padStart(2, '0');
    return `'${yyyy}-${mm}-${dd}'`;
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function jsonQ(v) {
  return `'${JSON.stringify(v ?? {}).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.query('SHOW TABLES LIKE ?', [tableName]);
  return rows.length > 0;
}

async function main() {
  const localConn = await mysql.createConnection({ uri: LOCAL_DB_URL, dateStrings: true });
  const prodConn = await mysql.createConnection({ uri: PROD_DB_URL, dateStrings: true });

  try {
    const missingTables = [];
    const createStatements = [];

    for (const table of REQUIRED_TABLES) {
      const exists = await tableExists(prodConn, table);
      if (!exists) {
        missingTables.push(table);
        const [createRows] = await localConn.query(`SHOW CREATE TABLE ${table}`);
        const createSql = createRows[0] && (createRows[0]['Create Table'] || createRows[0]['Create View']);
        if (createSql) {
          createStatements.push(`${createSql};`);
        }
      }
    }

    const [localHotelRows] = await localConn.query(
      'SELECT hotel_id, axisrooms_property_id FROM dvi_hotel WHERE axisrooms_property_id = ? LIMIT 1',
      [PROPERTY_ID],
    );
    const [prodHotelRows] = await prodConn.query(
      'SELECT hotel_id, axisrooms_property_id FROM dvi_hotel WHERE axisrooms_property_id = ? LIMIT 1',
      [PROPERTY_ID],
    );

    if (!localHotelRows[0]) throw new Error(`Local hotel not found for ${PROPERTY_ID}`);
    if (!prodHotelRows[0]) throw new Error(`Prod hotel not found for ${PROPERTY_ID}`);

    const localHotelId = Number(localHotelRows[0].hotel_id);
    const prodHotelId = Number(prodHotelRows[0].hotel_id);

    const [localRooms] = await localConn.query(
      'SELECT room_ID, room_ref_code, room_type_id FROM dvi_hotel_rooms WHERE hotel_id = ? AND deleted = 0',
      [localHotelId],
    );
    const [prodRooms] = await prodConn.query(
      'SELECT room_ID, room_ref_code, room_type_id FROM dvi_hotel_rooms WHERE hotel_id = ? AND deleted = 0',
      [prodHotelId],
    );

    const prodRoomsByRef = new Map(prodRooms.map((r) => [String(r.room_ref_code || ''), r]));
    const localRoomIds = localRooms.map((r) => Number(r.room_ID));

    const [localMaster] = await localConn.query(
      `SELECT rate_plan_code, default_rateplan_id, rate_plan_name, description,
              includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted
         FROM dvi_hotel_rate_plan_master
        WHERE deleted = 0 AND status = 1 AND rate_plan_code IN ('CP','EP','MAP','AP')
        ORDER BY sort_order ASC`,
    );

    const [localRatePlans] = await localConn.query(
      `SELECT hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name,
              meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted
         FROM dvi_hotel_room_rate_plan
        WHERE hotel_id = ? AND deleted = 0
        ORDER BY room_id ASC, rateplan_id ASC`,
      [localHotelId],
    );

    const [localOcc] = await localConn.query(
      `SELECT hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates
         FROM dvi_hotel_occupancy_rate
        WHERE hotel_id = ?
        ORDER BY room_id ASC, rateplan_id ASC, start_date ASC`,
      [localHotelId],
    );

    const lines = [];
    lines.push('-- AxisRooms production DB sync script');
    lines.push(`-- Property: ${PROPERTY_ID}`);
    lines.push(`-- Generated: ${new Date().toISOString()}`);
    lines.push('SET NAMES utf8mb4;');
    lines.push('START TRANSACTION;');
    lines.push('');

    if (createStatements.length) {
      lines.push('-- Missing table DDL from local schema');
      for (const ddl of createStatements) {
        lines.push(ddl);
      }
      lines.push('');
    }

    lines.push('-- Canonical rate plan master rows');
    for (const row of localMaster) {
      lines.push(
        `INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES (${q(row.rate_plan_code)}, ${q(row.default_rateplan_id)}, ${q(row.rate_plan_name)}, ${q(row.description)}, ${q(row.includes_breakfast)}, ${q(row.includes_lunch)}, ${q(row.includes_dinner)}, ${q(row.sort_order)}, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE default_rateplan_id=VALUES(default_rateplan_id), rate_plan_name=VALUES(rate_plan_name), description=VALUES(description), includes_breakfast=VALUES(includes_breakfast), includes_lunch=VALUES(includes_lunch), includes_dinner=VALUES(includes_dinner), sort_order=VALUES(sort_order), status=1, deleted=0, updatedon=NOW();`
      );
    }
    lines.push('');

    lines.push('-- Canonical room rate plan rows for this property');
    for (const row of localRatePlans) {
      if (!CANONICAL_RATEPLAN_IDS.has(String(row.rateplan_id || ''))) continue;
      const localRoom = localRooms.find((r) => Number(r.room_ID) === Number(row.room_id));
      if (!localRoom) continue;
      const ref = String(localRoom.room_ref_code || row.axisrooms_room_id || '');
      const prodRoom = prodRoomsByRef.get(ref);
      if (!prodRoom) {
        lines.push(`-- SKIP missing prod room_ref_code: ${ref}`);
        continue;
      }
      lines.push(
        `INSERT INTO dvi_hotel_room_rate_plan (hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name, meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted, createdon, updatedon) VALUES (${q(prodHotelId)}, ${q(prodRoom.room_ID)}, ${q(prodRoom.room_type_id || row.room_type_id || 0)}, ${q(ref)}, ${q(row.rate_plan_code)}, ${q(row.rateplan_id)}, ${q(row.rateplan_name)}, ${q(row.meal_plan_description)}, ${q(row.commission_perc)}, ${q(row.tax_perc)}, ${q(row.currency || 'INR')}, ${jsonQ(row.occupancy)}, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE room_type_id=VALUES(room_type_id), axisrooms_room_id=VALUES(axisrooms_room_id), rate_plan_code=VALUES(rate_plan_code), rateplan_name=VALUES(rateplan_name), meal_plan_description=VALUES(meal_plan_description), commission_perc=VALUES(commission_perc), tax_perc=VALUES(tax_perc), currency=VALUES(currency), occupancy=VALUES(occupancy), status=1, deleted=0, updatedon=NOW();`
      );
    }
    lines.push('');

    lines.push('-- Occupancy rate rows for canonical rate plans');
    for (const row of localOcc) {
      if (!CANONICAL_RATEPLAN_IDS.has(String(row.rateplan_id || ''))) continue;
      const localRoom = localRooms.find((r) => Number(r.room_ID) === Number(row.room_id));
      if (!localRoom) continue;
      const ref = String(localRoom.room_ref_code || '');
      const prodRoom = prodRoomsByRef.get(ref);
      if (!prodRoom) continue;
      const start = new Date(row.start_date);
      const end = new Date(row.end_date);
      const startDate = typeof row.start_date === 'string' ? row.start_date.slice(0, 10) : start;
      const endDate = typeof row.end_date === 'string' ? row.end_date.slice(0, 10) : end;
      lines.push(
        `INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (${q(prodHotelId)}, ${q(prodRoom.room_ID)}, ${q(row.rateplan_id)}, ${q(startDate)}, ${q(endDate)}, ${jsonQ(row.occupancy_rates)}, NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();`
      );
    }

    lines.push('');
    lines.push('COMMIT;');

    const outPath = path.resolve(process.cwd(), 'scripts', `prod-axisrooms-sync-${PROPERTY_ID}.sql`);
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

    const report = {
      propertyId: PROPERTY_ID,
      prodHotelId,
      localHotelId,
      missingTables,
      generatedSql: outPath,
      localCounts: {
        rooms: localRooms.length,
        canonicalRatePlans: localRatePlans.filter((r) => CANONICAL_RATEPLAN_IDS.has(String(r.rateplan_id || ''))).length,
        canonicalOccupancyRows: localOcc.filter((r) => CANONICAL_RATEPLAN_IDS.has(String(r.rateplan_id || ''))).length,
      },
      prodCounts: {
        rooms: prodRooms.length,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await localConn.end();
    await prodConn.end();
  }
}

main().catch((e) => {
  console.error('build-axisrooms-prod-sync-sql failed:', e.message || e);
  process.exit(1);
});
