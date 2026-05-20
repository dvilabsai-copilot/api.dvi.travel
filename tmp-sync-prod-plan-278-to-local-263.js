const mysql = require('mysql2/promise');

const SOURCE_PLAN_ID = 278;
const TARGET_PLAN_ID = 263;

const PROD = {
  host: '127.0.0.1',
  port: 13307,
  user: 'root',
  password: '8UMmdX#44PId#tdJ',
  database: 'dvi_main',
};

const LOCAL = {
  host: '127.0.0.1',
  port: 3306,
  user: 'dvi_user',
  password: 'myDvi123!',
  database: 'dvi_main',
};

const TABLES = [
  { name: 'dvi_itinerary_plan_hotel_room_amenities', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_plan_hotel_room_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_plan_hotel_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_plan_route_permit_charge', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_plan_vehicle_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_plan_vendor_vehicle_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_plan_vendor_eligible_list', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_route_activity_entry_cost_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_route_activity_details', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_route_guide_slot_cost_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_route_guide_details', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_route_hotspot_entry_cost_details', planCol: 'itinerary_plan_id' },
  { name: 'dvi_itinerary_route_hotspot_parking_charge', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_route_hotspot_details', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_via_route_details', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_traveller_details', planCol: 'itinerary_plan_ID' },
  { name: 'dvi_itinerary_route_details', planCol: 'itinerary_plan_ID' },
  { name: 'tbo_hotel_booking_confirmation', planCol: 'itinerary_plan_ID' },
];

async function getAutoIncCol(conn, table) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND EXTRA LIKE '%auto_increment%' LIMIT 1`,
    [table],
  );
  return rows[0]?.COLUMN_NAME || null;
}

function remapRow(row, planCol, routeMap, hotspotMap, eligibleMap) {
  const out = { ...row };

  for (const key of Object.keys(out)) {
    if (key === 'itinerary_plan_ID' || key === 'itinerary_plan_id') {
      out[key] = TARGET_PLAN_ID;
      continue;
    }

    if (key === 'itinerary_route_ID' || key === 'itinerary_route_id') {
      const oldVal = Number(out[key] || 0);
      if (oldVal > 0 && routeMap.has(oldVal)) {
        out[key] = routeMap.get(oldVal);
      }
      continue;
    }

    if (key === 'route_hotspot_ID') {
      const oldVal = Number(out[key] || 0);
      if (oldVal > 0 && hotspotMap.has(oldVal)) {
        out[key] = hotspotMap.get(oldVal);
      }
      continue;
    }

    if (key === 'itinerary_plan_vendor_eligible_ID') {
      const oldVal = Number(out[key] || 0);
      if (oldVal > 0 && eligibleMap.has(oldVal)) {
        out[key] = eligibleMap.get(oldVal);
      }
      continue;
    }
  }

  if (planCol && Object.prototype.hasOwnProperty.call(out, planCol)) {
    out[planCol] = TARGET_PLAN_ID;
  }

  return out;
}

async function insertOne(conn, table, row, autoIncCol) {
  const payload = { ...row };
  if (autoIncCol && Object.prototype.hasOwnProperty.call(payload, autoIncCol)) {
    delete payload[autoIncCol];
  }

  const cols = Object.keys(payload);
  if (!cols.length) return null;

  const sql = `INSERT INTO ${table} (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  const vals = cols.map((c) => {
    const v = payload[c];
    if (v === undefined) return null;
    if (Array.isArray(v)) return JSON.stringify(v);
    if (v && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
    return v;
  });
  const [res] = await conn.query(sql, vals);
  return res;
}

async function main() {
  const prod = await mysql.createConnection(PROD);
  const local = await mysql.createConnection(LOCAL);

  try {
    const [sourcePlanRows] = await prod.query(
      'SELECT * FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ? LIMIT 1',
      [SOURCE_PLAN_ID],
    );

    if (!sourcePlanRows.length) {
      throw new Error(`Source plan ${SOURCE_PLAN_ID} not found on production`);
    }

    const sourcePlan = sourcePlanRows[0];

    const [targetPlanRows] = await local.query(
      'SELECT itinerary_plan_ID, itinerary_quote_ID FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ? LIMIT 1',
      [TARGET_PLAN_ID],
    );

    if (!targetPlanRows.length) {
      throw new Error(`Target plan ${TARGET_PLAN_ID} not found on local`);
    }

    const routeMap = new Map();
    const hotspotMap = new Map();
    const eligibleMap = new Map();

    const autoIncMap = new Map();
    for (const t of TABLES) {
      autoIncMap.set(t.name, await getAutoIncCol(local, t.name));
    }

    await local.query('SET FOREIGN_KEY_CHECKS=0');
    await local.beginTransaction();

    for (const t of TABLES) {
      await local.query(`DELETE FROM ${t.name} WHERE ${t.planCol} = ?`, [TARGET_PLAN_ID]);
    }

    // Update target plan with production values but keep target plan ID fixed.
    const planPayload = { ...sourcePlan, itinerary_plan_ID: TARGET_PLAN_ID };
    delete planPayload.itinerary_plan_ID;
    const planCols = Object.keys(planPayload);
    const planSql = `UPDATE dvi_itinerary_plan_details SET ${planCols.map((c) => `\`${c}\` = ?`).join(',')} WHERE itinerary_plan_ID = ?`;
    await local.query(planSql, [...planCols.map((c) => planPayload[c]), TARGET_PLAN_ID]);

    // 1) Routes (establish old->new route mapping)
    {
      const [rows] = await prod.query('SELECT * FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_route_ID ASC', [SOURCE_PLAN_ID]);
      const autoInc = autoIncMap.get('dvi_itinerary_route_details');
      for (const row of rows) {
        const oldId = Number(row.itinerary_route_ID);
        const mapped = remapRow(row, 'itinerary_plan_ID', routeMap, hotspotMap, eligibleMap);
        const res = await insertOne(local, 'dvi_itinerary_route_details', mapped, autoInc);
        const newId = Number(res.insertId || 0);
        if (oldId > 0 && newId > 0) routeMap.set(oldId, newId);
      }
    }

    // 2) Route hotspots (establish old->new hotspot mapping)
    {
      const [rows] = await prod.query('SELECT * FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plan_ID = ? ORDER BY route_hotspot_ID ASC', [SOURCE_PLAN_ID]);
      const autoInc = autoIncMap.get('dvi_itinerary_route_hotspot_details');
      for (const row of rows) {
        const oldId = Number(row.route_hotspot_ID);
        const mapped = remapRow(row, 'itinerary_plan_ID', routeMap, hotspotMap, eligibleMap);
        const res = await insertOne(local, 'dvi_itinerary_route_hotspot_details', mapped, autoInc);
        const newId = Number(res.insertId || 0);
        if (oldId > 0 && newId > 0) hotspotMap.set(oldId, newId);
      }
    }

    // 3) Vendor eligible (establish old->new eligible mapping)
    {
      const [rows] = await prod.query('SELECT * FROM dvi_itinerary_plan_vendor_eligible_list WHERE itinerary_plan_id = ? ORDER BY itinerary_plan_vendor_eligible_ID ASC', [SOURCE_PLAN_ID]);
      const autoInc = autoIncMap.get('dvi_itinerary_plan_vendor_eligible_list');
      for (const row of rows) {
        const oldId = Number(row.itinerary_plan_vendor_eligible_ID);
        const mapped = remapRow(row, 'itinerary_plan_id', routeMap, hotspotMap, eligibleMap);
        const res = await insertOne(local, 'dvi_itinerary_plan_vendor_eligible_list', mapped, autoInc);
        const newId = Number(res.insertId || 0);
        if (oldId > 0 && newId > 0) eligibleMap.set(oldId, newId);
      }
    }

    const remaining = [
      { name: 'dvi_itinerary_plan_hotel_room_amenities', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_plan_hotel_room_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_plan_hotel_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_plan_route_permit_charge', planCol: 'itinerary_plan_ID' },
      { name: 'dvi_itinerary_plan_vehicle_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_plan_vendor_vehicle_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_route_activity_entry_cost_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_route_activity_details', planCol: 'itinerary_plan_ID' },
      { name: 'dvi_itinerary_route_guide_slot_cost_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_route_guide_details', planCol: 'itinerary_plan_ID' },
      { name: 'dvi_itinerary_route_hotspot_entry_cost_details', planCol: 'itinerary_plan_id' },
      { name: 'dvi_itinerary_route_hotspot_parking_charge', planCol: 'itinerary_plan_ID' },
      { name: 'dvi_itinerary_via_route_details', planCol: 'itinerary_plan_ID' },
      { name: 'dvi_itinerary_traveller_details', planCol: 'itinerary_plan_ID' },
      { name: 'tbo_hotel_booking_confirmation', planCol: 'itinerary_plan_ID' },
    ];

    for (const t of remaining) {
      const [rows] = await prod.query(`SELECT * FROM ${t.name} WHERE ${t.planCol} = ?`, [SOURCE_PLAN_ID]);
      const autoInc = autoIncMap.get(t.name);
      for (const row of rows) {
        const mapped = remapRow(row, t.planCol, routeMap, hotspotMap, eligibleMap);
        await insertOne(local, t.name, mapped, autoInc);
      }
    }

    await local.commit();
    await local.query('SET FOREIGN_KEY_CHECKS=1');

    console.log(JSON.stringify({
      status: 'ok',
      sourcePlan: SOURCE_PLAN_ID,
      targetPlan: TARGET_PLAN_ID,
      mappedRoutes: routeMap.size,
      mappedHotspots: hotspotMap.size,
      mappedEligible: eligibleMap.size,
    }, null, 2));
  } catch (err) {
    try { await local.rollback(); } catch {}
    try { await local.query('SET FOREIGN_KEY_CHECKS=1'); } catch {}
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prod.end();
    await local.end();
  }
}

main();
