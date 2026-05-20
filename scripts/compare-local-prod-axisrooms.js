const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const LOCAL_DB_URL = process.env.DATABASE_URL || '';
const PROD_DB_URL = process.env.PROD_DATABASE_URL || '';
const PROPERTY_ID = process.argv[2] || 'AX_DVI_HOTEL_153';

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
  if (v instanceof Date) {
    const yyyy = v.getUTCFullYear();
    const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(v.getUTCDate()).padStart(2, '0');
    return `'${yyyy}-${mm}-${dd}'`;
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v).replace(/\\/g, '\\\\').replace(/'/g, "''");
  return `'${s}'`;
}

function jsonQ(v) {
  const s = JSON.stringify(v ?? {}).replace(/\\/g, '\\\\').replace(/'/g, "''");
  return `'${s}'`;
}

async function fetchSnapshot(conn, propertyId) {
  const [hotels] = await conn.query(
    'SELECT hotel_id, axisrooms_property_id, axisrooms_enabled, deleted FROM dvi_hotel WHERE axisrooms_property_id = ? LIMIT 1',
    [propertyId],
  );
  const hotel = hotels[0] || null;
  if (!hotel) {
    return { hotel: null, rooms: [], rateplans: [], occupancy: [], master: [] };
  }

  const [rooms] = await conn.query(
    'SELECT room_ID, hotel_id, room_ref_code, room_type_id, room_title, status, deleted FROM dvi_hotel_rooms WHERE hotel_id = ? AND deleted = 0 ORDER BY room_ID ASC',
    [hotel.hotel_id],
  );

  const [rateplans] = await conn.query(
    `SELECT hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name,
            meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted
       FROM dvi_hotel_room_rate_plan
      WHERE hotel_id = ? AND deleted = 0
      ORDER BY room_id ASC, rateplan_id ASC`,
    [hotel.hotel_id],
  );

  const [occupancy] = await conn.query(
    `SELECT hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates
       FROM dvi_hotel_occupancy_rate
      WHERE hotel_id = ?
      ORDER BY room_id ASC, rateplan_id ASC, start_date ASC`,
    [hotel.hotel_id],
  );

  const [master] = await conn.query(
    `SELECT rate_plan_code, default_rateplan_id, rate_plan_name, description,
            includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted
       FROM dvi_hotel_rate_plan_master
      WHERE deleted = 0 AND status = 1 AND rate_plan_code IN ('CP','EP','MAP','AP')
      ORDER BY sort_order ASC`,
  );

  return { hotel, rooms, rateplans, occupancy, master };
}

function canonicalRatePlanId(id) {
  return ['CP_PLAN', 'EP_PLAN', 'MAP_PLAN', 'AP_PLAN'].includes(String(id || '').toUpperCase());
}

async function main() {
  const localConn = await mysql.createConnection(LOCAL_DB_URL);
  const prodConn = await mysql.createConnection(PROD_DB_URL);

  try {
    const [local, prod] = await Promise.all([
      fetchSnapshot(localConn, PROPERTY_ID),
      fetchSnapshot(prodConn, PROPERTY_ID),
    ]);

    if (!local.hotel) {
      throw new Error(`Local hotel not found for propertyId=${PROPERTY_ID}`);
    }
    if (!prod.hotel) {
      throw new Error(`Prod hotel not found for propertyId=${PROPERTY_ID}`);
    }

    const localRoomsByRef = new Map(local.rooms.map((r) => [String(r.room_ref_code || ''), r]));
    const prodRoomsByRef = new Map(prod.rooms.map((r) => [String(r.room_ref_code || ''), r]));

    const localMasterByCode = new Map(local.master.map((r) => [String(r.rate_plan_code), r]));
    const prodMasterByCode = new Map(prod.master.map((r) => [String(r.rate_plan_code), r]));

    const missingMaster = [];
    for (const [code, row] of localMasterByCode.entries()) {
      if (!prodMasterByCode.has(code)) missingMaster.push(row);
    }

    const prodRateplanKey = new Set(
      prod.rateplans
        .filter((r) => canonicalRatePlanId(r.rateplan_id))
        .map((r) => `${r.axisrooms_room_id}|${r.rateplan_id}`),
    );

    const missingRateplans = [];
    for (const row of local.rateplans) {
      if (!canonicalRatePlanId(row.rateplan_id)) continue;
      const ref = String(row.axisrooms_room_id || '');
      if (!prodRoomsByRef.has(ref)) continue;
      const key = `${ref}|${row.rateplan_id}`;
      if (!prodRateplanKey.has(key)) {
        missingRateplans.push(row);
      }
    }

    const prodOccKey = new Set(
      prod.occupancy
        .filter((r) => canonicalRatePlanId(r.rateplan_id))
        .map((r) => `${r.room_id}|${r.rateplan_id}|${new Date(r.start_date).toISOString().slice(0, 10)}|${new Date(r.end_date).toISOString().slice(0, 10)}`),
    );

    const missingOcc = [];
    for (const row of local.occupancy) {
      if (!canonicalRatePlanId(row.rateplan_id)) continue;
      const localRoom = local.rooms.find((r) => Number(r.room_ID) === Number(row.room_id));
      if (!localRoom) continue;
      const ref = String(localRoom.room_ref_code || '');
      const prodRoom = prodRoomsByRef.get(ref);
      if (!prodRoom) continue;
      const start = new Date(row.start_date).toISOString().slice(0, 10);
      const end = new Date(row.end_date).toISOString().slice(0, 10);
      const key = `${prodRoom.room_ID}|${row.rateplan_id}|${start}|${end}`;
      if (!prodOccKey.has(key)) {
        missingOcc.push({ ...row, room_id: prodRoom.room_ID, hotel_id: prod.hotel.hotel_id });
      }
    }

    const lines = [];
    lines.push('-- AxisRooms/Hotel rateplan sync script generated from local -> prod comparison');
    lines.push(`-- propertyId: ${PROPERTY_ID}`);
    lines.push(`-- generatedAt: ${new Date().toISOString()}`);
    lines.push('SET NAMES utf8mb4;');
    lines.push('START TRANSACTION;');

    for (const row of missingMaster) {
      lines.push(
        `INSERT INTO dvi_hotel_rate_plan_master (rate_plan_code, default_rateplan_id, rate_plan_name, description, includes_breakfast, includes_lunch, includes_dinner, sort_order, status, deleted, createdon, updatedon) VALUES (${q(row.rate_plan_code)}, ${q(row.default_rateplan_id)}, ${q(row.rate_plan_name)}, ${q(row.description)}, ${q(row.includes_breakfast)}, ${q(row.includes_lunch)}, ${q(row.includes_dinner)}, ${q(row.sort_order)}, 1, 0, NOW(), NOW());`
      );
    }

    for (const row of missingRateplans) {
      const ref = String(row.axisrooms_room_id || '');
      const prodRoom = prodRoomsByRef.get(ref);
      if (!prodRoom) continue;
      lines.push(
        `INSERT INTO dvi_hotel_room_rate_plan (hotel_id, room_id, room_type_id, axisrooms_room_id, rate_plan_code, rateplan_id, rateplan_name, meal_plan_description, commission_perc, tax_perc, currency, occupancy, status, deleted, createdon, updatedon) VALUES (${q(prod.hotel.hotel_id)}, ${q(prodRoom.room_ID)}, ${q(prodRoom.room_type_id || row.room_type_id || 0)}, ${q(ref)}, ${q(row.rate_plan_code)}, ${q(row.rateplan_id)}, ${q(row.rateplan_name)}, ${q(row.meal_plan_description)}, ${q(row.commission_perc)}, ${q(row.tax_perc)}, ${q(row.currency)}, ${jsonQ(row.occupancy)}, 1, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE rateplan_name=VALUES(rateplan_name), meal_plan_description=VALUES(meal_plan_description), commission_perc=VALUES(commission_perc), tax_perc=VALUES(tax_perc), currency=VALUES(currency), occupancy=VALUES(occupancy), status=1, deleted=0, updatedon=NOW();`
      );
    }

    for (const row of missingOcc) {
      const start = new Date(row.start_date).toISOString().slice(0, 10);
      const end = new Date(row.end_date).toISOString().slice(0, 10);
      lines.push(
        `INSERT INTO dvi_hotel_occupancy_rate (hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates, received_at) VALUES (${q(row.hotel_id)}, ${q(row.room_id)}, ${q(row.rateplan_id)}, ${q(start)}, ${q(end)}, ${jsonQ(row.occupancy_rates)}, NOW()) ON DUPLICATE KEY UPDATE occupancy_rates=VALUES(occupancy_rates), received_at=NOW();`
      );
    }

    lines.push('COMMIT;');

    const outPath = path.resolve(process.cwd(), 'scripts', `prod-sync-axisrooms-${PROPERTY_ID}.sql`);
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

    const report = {
      propertyId: PROPERTY_ID,
      local: {
        hotelId: local.hotel.hotel_id,
        rooms: local.rooms.length,
        canonicalRatePlans: local.rateplans.filter((r) => canonicalRatePlanId(r.rateplan_id)).length,
        canonicalOccupancyRows: local.occupancy.filter((r) => canonicalRatePlanId(r.rateplan_id)).length,
      },
      prod: {
        hotelId: prod.hotel.hotel_id,
        rooms: prod.rooms.length,
        canonicalRatePlans: prod.rateplans.filter((r) => canonicalRatePlanId(r.rateplan_id)).length,
        canonicalOccupancyRows: prod.occupancy.filter((r) => canonicalRatePlanId(r.rateplan_id)).length,
      },
      missingInProd: {
        ratePlanMasterRows: missingMaster.length,
        roomRatePlanRows: missingRateplans.length,
        occupancyRateRows: missingOcc.length,
      },
      sqlScript: outPath,
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await localConn.end();
    await prodConn.end();
  }
}

main().catch((e) => {
  console.error('compare-local-prod-axisrooms failed:', e.message || e);
  process.exit(1);
});
