require('dotenv').config();
const mysql = require('mysql2/promise');

function parseArgs(argv) {
  const args = {};
  for (const token of argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const [k, v] = token.slice(2).split('=');
    args[k] = v;
  }
  return {
    sourceVendorId: Number(args.sourceVendorId || args.sourceVendor || 41),
    targetVendorId: Number(args.targetVendorId || args.targetVendor || 43),
    sourceDb: args.sourceDb || 'dvi_travels',
    targetDb: args.targetDb || 'dvi_main',
  };
}

function getDbConfigFromEnv() {
  const raw = process.env.DATABASE_URL || '';
  const m = raw.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!m) throw new Error('DATABASE_URL is missing or invalid');
  return {
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
  };
}

async function insertRow(conn, table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const values = cols.map((c) => row[c]);
  const [res] = await conn.query(sql, values);
  return res.insertId;
}

function omit(row, keys) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
}

async function ensurePrimaryBranch(targetConn, sourceConn, sourceVendorId, targetVendorId) {
  const [targetBranches] = await targetConn.query(
    'SELECT * FROM dvi_vendor_branches WHERE vendor_id=? AND deleted=0 ORDER BY vendor_branch_id ASC',
    [targetVendorId],
  );
  if (targetBranches.length > 0) return targetBranches[0].vendor_branch_id;

  const [sourceBranches] = await sourceConn.query(
    'SELECT * FROM dvi_vendor_branches WHERE vendor_id=? AND deleted=0 ORDER BY vendor_branch_id ASC',
    [sourceVendorId],
  );

  const base = sourceBranches[0] || {
    vendor_branch_name: 'Main Branch',
    vendor_branch_address: '',
    vendor_branch_location: '',
    vendor_branch_country: 0,
    vendor_branch_state: 0,
    vendor_branch_city: 0,
    vendor_branch_pincode: 0,
    vendor_branch_phone: '',
    vendor_branch_email: '',
    vendor_branch_gst: 0,
    vendor_branch_gst_type: 1,
    createdby: 0,
    status: 1,
    deleted: 0,
  };

  const row = omit(base, new Set(['vendor_branch_id', 'vendor_id', 'createdon', 'updatedon']));
  row.vendor_id = targetVendorId;
  row.createdon = new Date();
  row.updatedon = null;
  if (row.status === undefined || row.status === null) row.status = 1;
  if (row.deleted === undefined || row.deleted === null) row.deleted = 0;

  return insertRow(targetConn, 'dvi_vendor_branches', row);
}

async function run() {
  const cfg = parseArgs(process.argv);
  if (!cfg.sourceVendorId || !cfg.targetVendorId) {
    throw new Error('sourceVendorId and targetVendorId are required');
  }

  const dbCfg = getDbConfigFromEnv();
  const sourceConn = await mysql.createConnection({ ...dbCfg, database: cfg.sourceDb });
  const targetConn = await mysql.createConnection({ ...dbCfg, database: cfg.targetDb });

  console.log(`Seeding vendor form data: ${cfg.sourceDb}:${cfg.sourceVendorId} -> ${cfg.targetDb}:${cfg.targetVendorId}`);

  await targetConn.beginTransaction();
  try {
    const [sourceVendorTypes] = await sourceConn.query(
      'SELECT * FROM dvi_vendor_vehicle_types WHERE vendor_id=? AND deleted=0 ORDER BY vendor_vehicle_type_ID ASC',
      [cfg.sourceVendorId],
    );
    if (sourceVendorTypes.length === 0) {
      throw new Error(`No source vehicle types found for vendor ${cfg.sourceVendorId} in ${cfg.sourceDb}`);
    }

    const primaryBranchId = await ensurePrimaryBranch(
      targetConn,
      sourceConn,
      cfg.sourceVendorId,
      cfg.targetVendorId,
    );

    const [existingTargetTypes] = await targetConn.query(
      'SELECT * FROM dvi_vendor_vehicle_types WHERE vendor_id=? AND deleted=0',
      [cfg.targetVendorId],
    );
    const existingByBaseType = new Map(
      existingTargetTypes.map((r) => [Number(r.vehicle_type_id), Number(r.vendor_vehicle_type_ID)]),
    );

    const sourceToTargetVehicleTypeId = new Map();

    for (const src of sourceVendorTypes) {
      const baseTypeId = Number(src.vehicle_type_id);
      const existingTargetId = existingByBaseType.get(baseTypeId);
      if (existingTargetId) {
        const updateData = omit(src, new Set(['vendor_vehicle_type_ID', 'vendor_id', 'createdon']));
        updateData.vendor_id = cfg.targetVendorId;
        updateData.vehicle_type_id = baseTypeId;
        updateData.updatedon = new Date();
        await targetConn.query(
          'UPDATE dvi_vendor_vehicle_types SET driver_batta=?, food_cost=?, accomodation_cost=?, extra_cost=?, driver_early_morning_charges=?, driver_evening_charges=?, status=?, deleted=?, updatedon=? WHERE vendor_vehicle_type_ID=?',
          [
            updateData.driver_batta ?? 0,
            updateData.food_cost ?? 0,
            updateData.accomodation_cost ?? 0,
            updateData.extra_cost ?? 0,
            updateData.driver_early_morning_charges ?? 0,
            updateData.driver_evening_charges ?? 0,
            updateData.status ?? 1,
            0,
            new Date(),
            existingTargetId,
          ],
        );
        sourceToTargetVehicleTypeId.set(Number(src.vendor_vehicle_type_ID), existingTargetId);
      } else {
        const row = omit(src, new Set(['vendor_vehicle_type_ID', 'vendor_id', 'createdon', 'updatedon']));
        row.vendor_id = cfg.targetVendorId;
        row.vehicle_type_id = baseTypeId;
        row.createdon = new Date();
        row.updatedon = null;
        row.deleted = 0;
        if (row.status === undefined || row.status === null) row.status = 1;
        const newId = await insertRow(targetConn, 'dvi_vendor_vehicle_types', row);
        sourceToTargetVehicleTypeId.set(Number(src.vendor_vehicle_type_ID), Number(newId));
      }
    }

    await targetConn.query('DELETE FROM dvi_time_limit WHERE vendor_id=?', [cfg.targetVendorId]);
    await targetConn.query('DELETE FROM dvi_kms_limit WHERE vendor_id=?', [cfg.targetVendorId]);

    const [sourceTimeLimits] = await sourceConn.query(
      'SELECT * FROM dvi_time_limit WHERE vendor_id=? AND deleted=0 ORDER BY time_limit_id ASC',
      [cfg.sourceVendorId],
    );
    const sourceToTargetTimeLimitId = new Map();
    for (const src of sourceTimeLimits) {
      const targetVtId = sourceToTargetVehicleTypeId.get(Number(src.vendor_vehicle_type_id));
      if (!targetVtId) continue;
      const row = omit(src, new Set(['time_limit_id', 'vendor_id', 'vendor_vehicle_type_id', 'createdon', 'updatedon']));
      row.vendor_id = cfg.targetVendorId;
      row.vendor_vehicle_type_id = targetVtId;
      row.createdon = new Date();
      row.updatedon = null;
      row.deleted = 0;
      const newId = await insertRow(targetConn, 'dvi_time_limit', row);
      sourceToTargetTimeLimitId.set(Number(src.time_limit_id), Number(newId));
    }

    const [sourceKmsLimits] = await sourceConn.query(
      'SELECT * FROM dvi_kms_limit WHERE vendor_id=? AND deleted=0 ORDER BY kms_limit_id ASC',
      [cfg.sourceVendorId],
    );
    const sourceToTargetKmsLimitId = new Map();
    for (const src of sourceKmsLimits) {
      const targetVtId = sourceToTargetVehicleTypeId.get(Number(src.vendor_vehicle_type_id));
      if (!targetVtId) continue;
      const row = omit(src, new Set(['kms_limit_id', 'vendor_id', 'vendor_vehicle_type_id', 'createdon', 'updatedon']));
      row.vendor_id = cfg.targetVendorId;
      row.vendor_vehicle_type_id = targetVtId;
      row.createdon = new Date();
      row.updatedon = null;
      row.deleted = 0;
      const newId = await insertRow(targetConn, 'dvi_kms_limit', row);
      sourceToTargetKmsLimitId.set(Number(src.kms_limit_id), Number(newId));
    }

    const [targetVehicles] = await targetConn.query(
      'SELECT * FROM dvi_vehicle WHERE vendor_id=? AND deleted=0 ORDER BY vehicle_id ASC',
      [cfg.targetVendorId],
    );
    const [sourceVehicles] = await sourceConn.query(
      'SELECT * FROM dvi_vehicle WHERE vendor_id=? AND deleted=0 ORDER BY vehicle_id ASC',
      [cfg.sourceVendorId],
    );

    const targetVehicleByType = new Map(
      targetVehicles.map((v) => [Number(v.vehicle_type_id), Number(v.vehicle_id)]),
    );

    const targetVehicleTemplate = targetVehicles[0] || sourceVehicles[0] || null;
    if (!targetVehicleTemplate) {
      throw new Error('No vehicle template available to seed dvi_vehicle rows');
    }

    for (const targetVtId of sourceToTargetVehicleTypeId.values()) {
      if (targetVehicleByType.has(Number(targetVtId))) continue;
      const row = omit(targetVehicleTemplate, new Set(['vehicle_id', 'vendor_id', 'vendor_branch_id', 'vehicle_type_id', 'createdon', 'updatedon']));
      row.vendor_id = cfg.targetVendorId;
      row.vendor_branch_id = primaryBranchId;
      row.vehicle_type_id = Number(targetVtId);
      row.createdon = new Date();
      row.updatedon = null;
      row.deleted = 0;
      row.status = 1;
      await insertRow(targetConn, 'dvi_vehicle', row);
    }

    await targetConn.query('DELETE FROM dvi_vehicle_local_pricebook WHERE vendor_id=?', [cfg.targetVendorId]);
    await targetConn.query('DELETE FROM dvi_vehicle_outstation_price_book WHERE vendor_id=?', [cfg.targetVendorId]);

    const [sourceLocalRows] = await sourceConn.query(
      'SELECT * FROM dvi_vehicle_local_pricebook WHERE vendor_id=? AND deleted=0 ORDER BY vehicle_price_book_id ASC',
      [cfg.sourceVendorId],
    );
    let localInserted = 0;
    for (const src of sourceLocalRows) {
      const mappedVtId = sourceToTargetVehicleTypeId.get(Number(src.vehicle_type_id));
      const mappedTlId = sourceToTargetTimeLimitId.get(Number(src.time_limit_id));
      if (!mappedVtId || !mappedTlId) continue;
      const row = omit(
        src,
        new Set([
          'vehicle_price_book_id',
          'vendor_id',
          'vendor_branch_id',
          'vehicle_type_id',
          'time_limit_id',
          'createdon',
          'updatedon',
        ]),
      );
      row.vendor_id = cfg.targetVendorId;
      row.vendor_branch_id = primaryBranchId;
      row.vehicle_type_id = Number(mappedVtId);
      row.time_limit_id = Number(mappedTlId);
      row.createdon = new Date();
      row.updatedon = null;
      row.deleted = 0;
      await insertRow(targetConn, 'dvi_vehicle_local_pricebook', row);
      localInserted += 1;
    }

    const [sourceOutRows] = await sourceConn.query(
      'SELECT * FROM dvi_vehicle_outstation_price_book WHERE vendor_id=? AND deleted=0 ORDER BY vehicle_outstation_price_book_id ASC',
      [cfg.sourceVendorId],
    );
    let outInserted = 0;
    for (const src of sourceOutRows) {
      const mappedVtId = sourceToTargetVehicleTypeId.get(Number(src.vehicle_type_id));
      const mappedKlId = sourceToTargetKmsLimitId.get(Number(src.kms_limit_id));
      if (!mappedVtId || !mappedKlId) continue;
      const row = omit(
        src,
        new Set([
          'vehicle_outstation_price_book_id',
          'vendor_id',
          'vendor_branch_id',
          'vehicle_type_id',
          'kms_limit_id',
          'createdon',
          'updatedon',
        ]),
      );
      row.vendor_id = cfg.targetVendorId;
      row.vendor_branch_id = primaryBranchId;
      row.vehicle_type_id = Number(mappedVtId);
      row.kms_limit_id = Number(mappedKlId);
      row.createdon = new Date();
      row.updatedon = null;
      row.deleted = 0;
      await insertRow(targetConn, 'dvi_vehicle_outstation_price_book', row);
      outInserted += 1;
    }

    await targetConn.commit();

    console.log('Seed complete');
    console.log(`vehicle_types=${sourceToTargetVehicleTypeId.size}`);
    console.log(`time_limits=${sourceToTargetTimeLimitId.size}`);
    console.log(`kms_limits=${sourceToTargetKmsLimitId.size}`);
    console.log(`local_pricebook_rows=${localInserted}`);
    console.log(`outstation_pricebook_rows=${outInserted}`);
  } catch (e) {
    await targetConn.rollback();
    throw e;
  } finally {
    await sourceConn.end();
    await targetConn.end();
  }
}

run().catch((e) => {
  console.error('Seed failed:', e.message || e);
  process.exit(1);
});
