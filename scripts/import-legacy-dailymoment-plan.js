/*
 * Import Daily Moment itinerary records from legacy PHP DB (dvi_travels)
 * into Nest DB (dvi_main) for one or more plan IDs.
 *
 * Usage:
 *   node scripts/import-legacy-dailymoment-plan.js 40377 40010
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const LEGACY_DB = process.env.LEGACY_PHP_DB_NAME || 'dvi_travels';

async function exec(sql, ...args) {
  return prisma.$executeRawUnsafe(sql, ...args);
}

async function safeExec(label, sql, ...args) {
  try {
    const n = await exec(sql, ...args);
    console.log(`OK ${label}: ${n}`);
  } catch (e) {
    console.log(`SKIP ${label}: ${e?.message || e}`);
  }
}

async function findLegacyItineraryPlanId(requestedId) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT itinerary_plan_ID
      FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_plan_details
      WHERE deleted = 0
        AND status = 1
        AND (itinerary_plan_ID = ? OR confirmed_itinerary_plan_ID = ?)
      LIMIT 1
    `,
    requestedId,
    requestedId,
  );
  if (!rows.length) return null;
  return Number(rows[0].itinerary_plan_ID || 0) || null;
}

async function importOne(requestedId) {
  const sourcePlanId = await findLegacyItineraryPlanId(requestedId);
  if (!sourcePlanId) {
    console.log(`SKIP ${requestedId}: not found in ${LEGACY_DB}`);
    return;
  }

  console.log(`Importing requested=${requestedId}, itinerary_plan_ID=${sourcePlanId} from ${LEGACY_DB} ...`);

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_plan_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_plan_details WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_customer_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_customer_details WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_route_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_route_details WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_route_hotspot_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_route_hotspot_details WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_route_guide_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_route_guide_details WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await exec(
    `INSERT IGNORE INTO dvi_confirmed_itinerary_plan_vendor_vehicle_details SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_plan_vendor_vehicle_details WHERE itinerary_plan_id = ?`,
    sourcePlanId,
  );

  await safeExec(
    'dailymoment_charge',
    `INSERT IGNORE INTO dvi_confirmed_itinerary_dailymoment_charge SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_dailymoment_charge WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await safeExec(
    'driver_feedback',
    `INSERT IGNORE INTO dvi_confirmed_itinerary_driver_feedback SELECT * FROM \`${LEGACY_DB}\`.dvi_confirmed_itinerary_driver_feedback WHERE itinerary_plan_ID = ?`,
    sourcePlanId,
  );

  await safeExec(
    'hotspot_master',
    `
      INSERT IGNORE INTO dvi_hotspot_place
        (hotspot_ID, hotspot_type, hotspot_name, hotspot_description, hotspot_address,
         hotspot_landmark, hotspot_location, hotspot_priority, hotspot_adult_entry_cost,
         hotspot_child_entry_cost, hotspot_infant_entry_cost, hotspot_foreign_adult_entry_cost,
         hotspot_foreign_child_entry_cost, hotspot_foreign_infant_entry_cost, hotspot_duration,
         hotspot_rating, hotspot_latitude, hotspot_longitude, hotspot_video_url,
         createdby, createdon, updatedon, status, deleted)
      SELECT
         hp.hotspot_ID, hp.hotspot_type, hp.hotspot_name, hp.hotspot_description, hp.hotspot_address,
         hp.hotspot_landmark, hp.hotspot_location, hp.hotspot_priority, hp.hotspot_adult_entry_cost,
         hp.hotspot_child_entry_cost, hp.hotspot_infant_entry_cost, hp.hotspot_foreign_adult_entry_cost,
         hp.hotspot_foreign_child_entry_cost, hp.hotspot_foreign_infant_entry_cost, hp.hotspot_duration,
         hp.hotspot_rating, hp.hotspot_latitude, hp.hotspot_longitude, hp.hotspot_video_url,
         hp.createdby, hp.createdon, hp.updatedon, hp.status, hp.deleted
      FROM \`${LEGACY_DB}\`.dvi_hotspot_place hp
      INNER JOIN \`${LEGACY_DB}\`.dvi_confirmed_itinerary_route_hotspot_details rh
        ON rh.hotspot_ID = hp.hotspot_ID
      WHERE rh.itinerary_plan_ID = ?
    `,
    sourcePlanId,
  );

  await safeExec(
    'guide_master',
    `
      INSERT IGNORE INTO dvi_guide_details
      SELECT gd.*
      FROM \`${LEGACY_DB}\`.dvi_guide_details gd
      INNER JOIN \`${LEGACY_DB}\`.dvi_confirmed_itinerary_route_guide_details rg
        ON rg.guide_id = gd.guide_id
      WHERE rg.itinerary_plan_ID = ?
    `,
    sourcePlanId,
  );

  await safeExec(
    'staff_master',
    `
      INSERT IGNORE INTO dvi_staff
      SELECT st.*
      FROM \`${LEGACY_DB}\`.dvi_staff st
      INNER JOIN \`${LEGACY_DB}\`.dvi_confirmed_itinerary_plan_details pd
        ON pd.staff_id = st.staff_id
      WHERE pd.itinerary_plan_ID = ?
    `,
    sourcePlanId,
  );

  console.log(`DONE ${requestedId} -> ${sourcePlanId}`);
}

async function main() {
  const ids = process.argv.slice(2).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) {
    console.error('Please pass at least one plan id. Example: node scripts/import-legacy-dailymoment-plan.js 40377');
    process.exit(1);
  }

  for (const id of ids) {
    await importOne(id);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
