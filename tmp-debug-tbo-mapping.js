// tmp-debug-tbo-mapping.js
// Investigates why TBO hotels are not appearing for Madurai / Thanjavur / Mahabalipuram
// Run: node tmp-debug-tbo-mapping.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function run() {
  const targetDestinations = ['Madurai', 'Thanjavur', 'Mahabalipuram'];

  console.log('\n════════════════════════════════════════════');
  console.log(' TBO MAPPING INVESTIGATION');
  console.log('════════════════════════════════════════════\n');

  // 1. Check dvi_cities for each destination
  console.log('── 1. dvi_cities lookup (by name, exact+partial) ──');
  for (const dest of targetDestinations) {
    const rows = await p.$queryRawUnsafe(
      `SELECT id, name, tbo_city_code, hobse_city_code, status, deleted
       FROM dvi_cities
       WHERE name LIKE ?
       LIMIT 10`,
      `%${dest}%`
    );
    const safe = rows.map(r => ({
      id: Number(r.id),
      name: r.name,
      tbo_city_code: r.tbo_city_code,
      hobse_city_code: r.hobse_city_code,
      status: Number(r.status),
      deleted: Number(r.deleted),
    }));
    console.log(`  "${dest}" → dvi_cities matches: ${safe.length}`);
    if (safe.length > 0) console.log('  ', JSON.stringify(safe));
    else console.log('   ⚠️  NO MATCH in dvi_cities');
  }

  // 2. Check dvi_hotel.tbo_city_code for each destination name
  console.log('\n── 2. dvi_hotel.tbo_city_code by hotel_city name ──');
  for (const dest of targetDestinations) {
    const rows = await p.$queryRawUnsafe(
      `SELECT DISTINCT hotel_city, tbo_city_code, COUNT(*) as cnt
       FROM dvi_hotel
       WHERE hotel_city = ? AND tbo_hotel_code IS NOT NULL AND tbo_hotel_code != ''
         AND status = 1 AND (deleted = 0 OR deleted IS NULL)
       GROUP BY hotel_city, tbo_city_code
       LIMIT 5`,
      dest
    );
    const safe = rows.map(r => ({
      hotel_city: r.hotel_city,
      tbo_city_code: r.tbo_city_code,
      cnt: Number(r.cnt),
    }));
    console.log(`  "${dest}" → dvi_hotel city+tbo_city_code: ${safe.length}`);
    if (safe.length > 0) console.log('  ', JSON.stringify(safe));
    else console.log('   ⚠️  NO MATCH (or tbo_city_code is null)');
  }

  // 3. Check tbo_hotel_master for each destination name
  console.log('\n── 3. tbo_hotel_master.city_name lookup ──');
  for (const dest of targetDestinations) {
    const rows = await p.$queryRawUnsafe(
      `SELECT tbo_city_code, city_name, COUNT(*) as cnt
       FROM tbo_hotel_master
       WHERE city_name LIKE ?
       GROUP BY tbo_city_code, city_name
       LIMIT 5`,
      `%${dest}%`
    );
    const safe = rows.map(r => ({
      tbo_city_code: r.tbo_city_code,
      city_name: r.city_name,
      cnt: Number(r.cnt),
    }));
    console.log(`  "${dest}" → tbo_hotel_master matches: ${safe.length}`);
    if (safe.length > 0) console.log('  ', JSON.stringify(safe));
    else console.log('   ⚠️  NO MATCH in tbo_hotel_master');
  }

  // 4. Check if tbo_hotel_master has ANY rows at all
  console.log('\n── 4. tbo_hotel_master total row count ──');
  const totalMaster = await p.$queryRawUnsafe(
    `SELECT COUNT(*) as cnt, COUNT(DISTINCT tbo_city_code) as cities FROM tbo_hotel_master`
  );
  console.log('  Total:', JSON.stringify(totalMaster.map(r => ({ cnt: Number(r.cnt), cities: Number(r.cities) }))));

  // 5. Sample top-5 city codes in tbo_hotel_master
  const masterCities = await p.$queryRawUnsafe(
    `SELECT tbo_city_code, city_name, COUNT(*) as cnt FROM tbo_hotel_master
     GROUP BY tbo_city_code, city_name ORDER BY cnt DESC LIMIT 10`
  );
  console.log('  Top cities in tbo_hotel_master:', JSON.stringify(
    masterCities.map(r => ({ tbo_city_code: r.tbo_city_code, city_name: r.city_name, cnt: Number(r.cnt) }))
  ));

  // 6. Check plan/routes for DVI2026037
  console.log('\n── 5. Plan/Routes for DVI2026037 ──');
  const plan = await p.$queryRawUnsafe(
    `SELECT itinerary_plan_ID, itinerary_quote_ID, no_of_nights, no_of_days, nationality
     FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = ? AND deleted = 0`,
    'DVI2026037'
  );
  if (plan.length === 0) {
    console.log('  ⚠️  Quote DVI2026037 not found in dvi_itinerary_plan_details');
  } else {
    const planId = Number(plan[0].itinerary_plan_ID);
    console.log('  Plan:', JSON.stringify(plan.map(r => ({
      planId: Number(r.itinerary_plan_ID),
      quoteId: r.itinerary_quote_ID,
      nights: Number(r.no_of_nights),
      nationality: Number(r.nationality),
    }))));

    const routes = await p.$queryRawUnsafe(
      `SELECT itinerary_route_ID, location_name, next_visiting_location, itinerary_route_date, no_of_days
       FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? AND deleted = 0
       ORDER BY itinerary_route_date ASC`,
      planId
    );
    console.log('  Routes:');
    routes.forEach(r => console.log(`    Day ${Number(r.no_of_days)}: "${r.location_name}" → "${r.next_visiting_location}" (${r.itinerary_route_date})`));

    // 6b. Check saved hotel rows (using actual schema columns)
    console.log('\n── 6b. Saved hotel rows shape for this plan ──');
    const hotelRowCount = await p.$queryRawUnsafe(
      `SELECT COUNT(*) as cnt, SUM(hotel_id=0) as zero_hotel_id, SUM(total_hotel_cost=0) as zero_cost
       FROM dvi_itinerary_plan_hotel_details WHERE itinerary_plan_id = ? AND deleted = 0`,
      planId
    );
    console.log('  ', JSON.stringify(hotelRowCount.map(r => ({ cnt: Number(r.cnt), zero_hotel_id: Number(r.zero_hotel_id), zero_cost: Number(r.zero_cost) }))));
  }

  // 8. dvi_countries check for nationality 101
  console.log('\n── 7. dvi_countries for nationality id=101 ──');
  const country = await p.$queryRawUnsafe(
    `SELECT id, name, shortname FROM dvi_countries WHERE id = 101 AND deleted = 0 AND status = 1 LIMIT 1`
  );
  console.log(' ', JSON.stringify(country));
  // 8. dvi_cities total with tbo_city_code populated
  console.log('\n── 8. dvi_cities with tbo_city_code populated ──');
  const citiesWithCode = await p.$queryRawUnsafe(
    `SELECT COUNT(*) as cnt FROM dvi_cities WHERE tbo_city_code IS NOT NULL AND tbo_city_code != ''`
  );
  console.log('  dvi_cities rows with tbo_city_code:', JSON.stringify(citiesWithCode.map(r => ({ cnt: Number(r.cnt) }))));

  // 9. Saved hotel rows for plan 24 (correct columns)
  console.log('\n── 9. Saved hotel rows for planId=24 (DVI2026037) ──');
  const savedRows = await p.$queryRawUnsafe(
    `SELECT itinerary_plan_hotel_details_ID, group_type, itinerary_route_id, hotel_id, hotel_code, total_hotel_cost
     FROM dvi_itinerary_plan_hotel_details WHERE itinerary_plan_id = 24 AND deleted = 0
     ORDER BY group_type, itinerary_route_id`
  );
  console.log(`  Saved rows: ${savedRows.length}`);
  savedRows.forEach(r => console.log(`    Group${Number(r.group_type)} Route${Number(r.itinerary_route_id)} hotelId=${Number(r.hotel_id)} hotelCode=${r.hotel_code} cost=${Number(r.total_hotel_cost)}`));

  // 10. Sample hotel codes from tbo_hotel_master for Madurai
  console.log('\n── 10. Sample tbo_hotel_master codes for Madurai (127067) ──');
  const masterSample = await p.$queryRawUnsafe(
    `SELECT tbo_hotel_code, hotel_name FROM tbo_hotel_master WHERE tbo_city_code = '127067' AND status = 1 LIMIT 5`
  );
  console.log('  Sample:', JSON.stringify(masterSample.map(r => ({ code: r.tbo_hotel_code, name: r.hotel_name }))));
  console.log('\n════════════════════════════════════════════\n');
}

run()
  .catch(e => console.error('❌ Error:', e.message))
  .finally(() => p.$disconnect());
