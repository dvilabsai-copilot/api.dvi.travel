const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PLAN_ID = 386;

async function q(title, fn) {
  console.log(`\n===== ${title} =====`);
  const rows = await fn();
  console.log(JSON.stringify(rows, (k,v)=> typeof v === 'bigint' ? v.toString() : v, 2));
  return rows;
}

(async () => {
  try {
    await q('SECTION 1: Plan row', async () => prisma.$queryRawUnsafe(`
      SELECT
        itinerary_plan_ID AS itinerary_plan_id,
        itinerary_quote_ID,
        arrival_location AS arrival_point,\n        departure_location AS departure_point,
        itinerary_preference,
        itinerary_type,
        trip_start_date_and_time AS trip_start_date,\n        trip_end_date_and_time AS trip_end_date,
        pick_up_date_and_time,
        no_of_days,
        no_of_nights,
        deleted,
        status
      FROM dvi_itinerary_plan_details
      WHERE itinerary_plan_ID = ${PLAN_ID}
    `));

    await q('SECTION 2: Route rows stored', async () => prisma.$queryRawUnsafe(`
      SELECT
        itinerary_route_ID,
        itinerary_plan_ID,
        no_of_days,
        itinerary_route_date,
        location_id,
        location_name,
        next_visiting_location,
        no_of_km,
        direct_to_next_visiting_place,
        route_start_time,
        route_end_time,
        deleted,
        status
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = ${PLAN_ID}
      ORDER BY no_of_days ASC, itinerary_route_ID ASC
    `));

    await q('SECTION 3: Stored location rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        location_ID,
        source_location,
        destination_location,
        source_location_city,
        destination_location_city,
        distance,
        duration,
        source_location_lattitude AS latitude,\n        source_location_longitude AS longitude,\n        destination_location_lattitude AS destination_latitude,\n        destination_location_longitude AS destination_longitude,
        deleted,
        status
      FROM dvi_stored_locations
      WHERE deleted = 0
        AND status = 1
        AND (
          (source_location = 'Chennai International Airport' AND destination_location = 'Chennai')
          OR (source_location = 'Chennai' AND destination_location = 'Chennai International Airport')
          OR (source_location = 'Chennai' AND destination_location = 'Chennai')
          OR (source_location = 'Chennai Koyembedu' AND destination_location = 'Chennai')
          OR (source_location = 'Chennai' AND destination_location = 'Chennai Koyembedu')
          OR (source_location = 'Chennai Koyembedu' AND destination_location = 'Chennai International Airport')
          OR (source_location = 'Chennai International Airport' AND destination_location = 'Chennai Koyembedu')
        )
      ORDER BY location_ID DESC
    `));

    await q('SECTION 4A: Vendor eligible rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        itinerary_plan_vendor_eligible_ID,
        itinerary_plan_id,
        vendor_id,
        vendor_branch_id,
        vehicle_type_id,
        vendor_vehicle_type_id,
        vehicle_id,
        total_vehicle_qty,
        itineary_plan_assigned_status,
        status,
        deleted
      FROM dvi_itinerary_plan_vendor_eligible_list
      WHERE itinerary_plan_id = ${PLAN_ID}
      ORDER BY itineary_plan_assigned_status DESC, itinerary_plan_vendor_eligible_ID ASC
    `));

    await q('SECTION 4B: Vehicle rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        vehicle_id,
        vendor_id,
        vendor_branch_id,
        vehicle_type_id,
        vehicle_location_id,
        extra_km_charge,
        extra_hour_charge,
        early_morning_charges,
        evening_charges,
        status,
        deleted
      FROM dvi_vehicle
      WHERE vehicle_id IN (
        SELECT vehicle_id
        FROM dvi_itinerary_plan_vendor_eligible_list
        WHERE itinerary_plan_id = ${PLAN_ID}
      )
    `));

    await q('SECTION 4C: Vehicle location rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        location_ID,
        source_location,
        destination_location,
        source_location_city,
        destination_location_city,
        distance,\n        duration,\n        source_location_lattitude AS latitude,\n        source_location_longitude AS longitude,\n        destination_location_lattitude AS destination_latitude,\n        destination_location_longitude AS destination_longitude
      FROM dvi_stored_locations
      WHERE location_ID IN (
        SELECT vehicle_location_id
        FROM dvi_vehicle
        WHERE vehicle_id IN (
          SELECT vehicle_id
          FROM dvi_itinerary_plan_vendor_eligible_list
          WHERE itinerary_plan_id = ${PLAN_ID}
        )
      )
    `));

    await q('SECTION 5A: Hotspot movement rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        route_hotspot_ID AS itinerary_route_hotspot_details_ID,
        itinerary_plan_ID,
        itinerary_route_ID,
        route_hotspot_ID AS route_hotspot_id,
        hotspot_ID AS hotspot_id,
        CAST(NULL AS CHAR) AS hotspot_name,
        item_type,
        hotspot_travelling_distance,
        hotspot_traveling_time,
        hotspot_start_time AS start_time,
        hotspot_end_time AS end_time,
        deleted,
        status
      FROM dvi_itinerary_route_hotspot_details
      WHERE itinerary_plan_ID = ${PLAN_ID}
      ORDER BY itinerary_route_ID ASC, itinerary_route_hotspot_details_ID ASC
    `));

    await q('SECTION 5B: Hotspot grouped summary', async () => prisma.$queryRawUnsafe(`
      SELECT
        itinerary_route_ID,
        item_type,
        COUNT(*) AS row_count,
        SUM(CAST(hotspot_travelling_distance AS DECIMAL(10,2))) AS total_distance
      FROM dvi_itinerary_route_hotspot_details
      WHERE itinerary_plan_ID = ${PLAN_ID}
        AND deleted = 0
      GROUP BY itinerary_route_ID, item_type
      ORDER BY itinerary_route_ID ASC, item_type ASC
    `));

    await q('SECTION 6: Final vehicle detail rows', async () => prisma.$queryRawUnsafe(`
      SELECT
        itinerary_plan_vendor_vehicle_details_ID,
        itinerary_plan_vendor_eligible_ID,
        itinerary_plan_id,
        itinerary_route_id,
        itinerary_route_date,
        vehicle_type_id,
        vehicle_qty,
        vendor_id,
        vendor_vehicle_type_id,
        vehicle_id,
        vendor_branch_id,
        time_limit_id,
        travel_type,
        itinerary_route_location_from,
        itinerary_route_location_to,
        total_pickup_km,
        total_running_km,
        total_siteseeing_km,
        total_drop_km,
        total_travelled_km,
        total_pickup_duration,
        total_running_time,
        total_siteseeing_time,
        total_drop_duration,
        total_travelled_time,
        vehicle_rental_charges,
        total_extra_km,
        extra_km_rate,
        total_extra_km_charges,
        total_vehicle_amount,
        deleted,
        status
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_plan_id = ${PLAN_ID}
      ORDER BY itinerary_route_date ASC, itinerary_route_id ASC
    `));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();





