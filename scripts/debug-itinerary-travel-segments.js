/**
 * DEBUG SCRIPT: Itinerary Travel Segments Investigation
 * 
 * Purpose: Prove source of travel segment anomalies in quote DVI202604230:
 * 1. from == to (both "Vivekanandar House")
 * 2. reversed timeRange (08:36 PM - 08:00 PM)
 * 3. travel appears after checkin
 */

const mysql = require('mysql2/promise');

const quoteId = 'DVI202604230';

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    console.log('\n========================================');
    console.log('ITINERARY TRAVEL SEGMENTS INVESTIGATION');
    console.log(`Quote: ${quoteId}`);
    console.log('========================================\n');

    // ======================== STEP 1: GET PLAN ========================
    console.log('STEP 1: Fetch Plan');
    console.log('-------------------');
    const [planRows] = await conn.query(
      `SELECT 
        itinerary_plan_ID,
        itinerary_quote_ID,
        arrival_location,
        departure_location,
        trip_start_date_and_time,
        trip_end_date_and_time,
        deleted
       FROM dvi_itinerary_plan_details
       WHERE itinerary_quote_ID = ? AND deleted = 0`,
      [quoteId]
    );

    if (!planRows.length) {
      console.error('Plan not found!');
      process.exit(1);
    }

    const plan = planRows[0];
    console.log(`Plan ID: ${plan.itinerary_plan_ID}`);
    console.log(`Quote: ${plan.itinerary_quote_ID}`);
    console.log(`Arrival: ${plan.arrival_location}`);
    console.log(`Departure: ${plan.departure_location}`);
    console.log(`Dates: ${plan.trip_start_date_and_time} to ${plan.trip_end_date_and_time}\n`);

    // ======================== STEP 2: GET ROUTES ========================
    console.log('STEP 2: Fetch All Routes');
    console.log('------------------------');
    const [routeRows] = await conn.query(
      `SELECT 
        itinerary_route_ID,
        itinerary_plan_ID,
        location_id,
        location_name,
        next_visiting_location,
        itinerary_route_date,
        route_start_time,
        route_end_time,
        deleted
       FROM dvi_itinerary_route_details
       WHERE itinerary_plan_ID = ? AND deleted = 0
       ORDER BY itinerary_route_ID ASC`,
      [plan.itinerary_plan_ID]
    );

    console.log(`Found ${routeRows.length} routes\n`);
    for (const route of routeRows) {
      console.log(`Route ${route.itinerary_route_ID}:`);
      console.log(`  Location: ${route.location_name} → ${route.next_visiting_location}`);
      console.log(`  Date: ${route.itinerary_route_date}`);
      console.log(`  Time: ${route.route_start_time} to ${route.route_end_time}`);
    }

    // ======================== STEP 3: GET HOTELS ========================
    console.log('\n\nSTEP 3: Fetch Hotels for Routes');
    console.log('-------------------------------');
    const [hotelRows] = await conn.query(
      `SELECT 
        itinerary_route_id,
        hotel_id,
        group_type,
        deleted
       FROM dvi_itinerary_plan_hotel_details
       WHERE itinerary_plan_id = ? AND deleted = 0`,
      [plan.itinerary_plan_ID]
    );

    const routeHotelMap = new Map(hotelRows.map(h => [h.itinerary_route_id, h.hotel_id]));
    console.log(`Found ${hotelRows.length} hotel assignments\n`);

    // Fetch hotel details
    const hotelIds = [...new Set(hotelRows.map(h => h.hotel_id))];
    if (hotelIds.length > 0) {
      const [hotelDetails] = await conn.query(
        `SELECT hotel_id, hotel_name FROM dvi_hotel WHERE hotel_id IN (?)`,
        [hotelIds]
      );
      
      const hotelNameMap = new Map(hotelDetails.map(h => [h.hotel_id, h.hotel_name]));
      
      for (const [routeId, hotelId] of routeHotelMap) {
        const hotelName = hotelNameMap.get(hotelId);
        console.log(`Route ${routeId} → Hotel ${hotelId} (${hotelName})`);
      }
    }

    // ======================== STEP 4: GET HOTSPOTS FOR EACH ROUTE ========================
    console.log('\n\nSTEP 4: Raw Hotspot Rows from DB (item_type breakdown)');
    console.log('-------------------------------------------------------\n');

    for (const route of routeRows) {
      console.log(`\n╔════════════════════════════════════════════════════╗`);
      console.log(`║ ROUTE ${route.itinerary_route_ID}: ${route.location_name} → ${route.next_visiting_location}`);
      console.log(`║ Date: ${route.itinerary_route_date}`);
      console.log(`║ Route Time: ${route.route_start_time} to ${route.route_end_time}`);
      console.log(`╚════════════════════════════════════════════════════╝`);

      const [hotspotRows] = await conn.query(
        `SELECT 
          route_hotspot_ID,
          item_type,
          hotspot_order,
          hotspot_ID,
          hotspot_start_time,
          hotspot_end_time,
          hotspot_traveling_time,
          hotspot_travelling_distance,
          allow_break_hours,
          allow_via_route,
          via_location_name,
          is_conflict,
          conflict_reason,
          createdon
         FROM dvi_itinerary_route_hotspot_details
         WHERE itinerary_route_ID = ? AND deleted = 0
         ORDER BY hotspot_order ASC`,
        [route.itinerary_route_ID]
      );

      if (!hotspotRows.length) {
        console.log('  [NO HOTSPOTS]');
        continue;
      }

      // Fetch hotspot masters
      const hotspotIds = hotspotRows
        .map(r => r.hotspot_ID)
        .filter(id => id > 0);
      
      const hotspotMasters = hotspotIds.length 
        ? await conn.query(
            `SELECT hotspot_ID, hotspot_name FROM dvi_hotspot_place WHERE hotspot_ID IN (?)`,
            [hotspotIds]
          ).then(([rows]) => rows)
        : [];

      const hotelName = routeHotelMap.get(route.itinerary_route_ID)
        ? hotelNameMap.get(routeHotelMap.get(route.itinerary_route_ID))
        : null;

      const hotspotNameMap = new Map(
        hotspotMasters.map(h => [h.hotspot_ID, h.hotspot_name])
      );

      // Print each row
      for (let idx = 0; idx < hotspotRows.length; idx++) {
        const row = hotspotRows[idx];
        const itemTypeNames = {
          0: 'Unknown',
          1: 'START/BREAK',
          2: 'TRAVEL',
          3: 'TRAVEL/BREAK/VIA',
          4: 'ATTRACTION',
          5: 'TRAVEL_TO_HOTEL',
          6: 'HOTEL_CHECKIN',
          7: 'DROPOFF'
        };

        const hotspotName = hotspotNameMap.get(row.hotspot_ID) || '(no hotspot)';

        console.log(`\n  [Row ${idx}] route_hotspot_ID=${row.route_hotspot_ID}, hotspot_order=${row.hotspot_order}`);
        console.log(`  ├─ item_type=${row.item_type} (${itemTypeNames[row.item_type] || '?'})`);
        console.log(`  ├─ hotspot_ID=${row.hotspot_ID} → ${hotspotName}`);
        console.log(`  ├─ hotspot_start_time=${row.hotspot_start_time}`);
        console.log(`  ├─ hotspot_end_time=${row.hotspot_end_time}`);
        console.log(`  ├─ hotspot_traveling_time=${row.hotspot_traveling_time} (duration)`);
        console.log(`  ├─ hotspot_travelling_distance=${row.hotspot_travelling_distance}`);
        
        if (row.allow_break_hours === 1) {
          console.log(`  ├─ allow_break_hours=1 (BREAK/LUNCH)`);
        }
        if (row.allow_via_route === 1) {
          console.log(`  ├─ allow_via_route=1, via_location_name='${row.via_location_name}'`);
        }
        if (row.is_conflict) {
          console.log(`  ├─ is_conflict=1: ${row.conflict_reason}`);
        }

        // Analyze this row based on item_type
        console.log(`  └─ ANALYSIS:`);
        
        if (row.item_type === 2) {
          console.log(`     → TRAVEL from previousStop to route.next_visiting_location`);
          console.log(`     → timeRange derived from hotspot_start_time and hotspot_end_time`);
        } else if (row.item_type === 3) {
          if (row.allow_break_hours === 1) {
            console.log(`     → BREAK segment`);
          } else if (row.allow_via_route === 1) {
            console.log(`     → VIA_ROUTE travel`);
          } else {
            console.log(`     → REGULAR travel or attraction (depends on master hotspot_ID)`);
          }
        } else if (row.item_type === 4) {
          console.log(`     → ATTRACTION visit to ${hotspotName}`);
        } else if (row.item_type === 5) {
          console.log(`     → TRAVEL TO HOTEL`);
          console.log(`     → from previousStop to ${hotelName || 'Hotel'}`);
          console.log(`     → timeRange from hotspot_start_time/hotspot_end_time`);
        } else if (row.item_type === 6) {
          console.log(`     → HOTEL CHECK-IN`);
          console.log(`     → checkin time uses hotspot_end_time → ${row.hotspot_end_time}`);
          console.log(`     → fallback: hotspot_start_time → ${row.hotspot_start_time}`);
          console.log(`     → fallback: route.route_end_time → ${route.route_end_time}`);
        }
      }
    }

    // ======================== STEP 5: CALL ACTUAL API ========================
    console.log('\n\n╔════════════════════════════════════════════════════╗');
    console.log('║ STEP 5: Fetch Actual API Response');
    console.log('╚════════════════════════════════════════════════════╝\n');
    
    const response = await fetch(`http://localhost:4006/api/v1/itineraries/details/${quoteId}`);
    const apiData = await response.json();

    console.log('API Response Days:');
    for (const day of apiData.days) {
      console.log(`\nDay ${day.dayNumber} (${day.date}):`);
      console.log(`Location: ${day.departure} → ${day.arrival}`);
      console.log(`Segments: ${day.segments.length}`);
      
      for (let i = 0; i < day.segments.length; i++) {
        const seg = day.segments[i];
        console.log(`\n  [${i}] type=${seg.type}`);
        
        if (seg.type === 'travel') {
          console.log(`      from='${seg.from}' to='${seg.to}'`);
          console.log(`      timeRange='${seg.timeRange}'`);
          console.log(`      distance='${seg.distance}'`);
        } else if (seg.type === 'checkin') {
          console.log(`      hotel='${seg.hotelName}'`);
          console.log(`      time='${seg.time}'`);
        } else if (seg.type === 'attraction') {
          console.log(`      name='${seg.name}'`);
          console.log(`      visitTime='${seg.visitTime}'`);
        }
      }
    }

    console.log('\n========================================');
    console.log('INVESTIGATION COMPLETE');
    console.log('========================================\n');

  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
