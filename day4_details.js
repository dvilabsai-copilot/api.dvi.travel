const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    const routeId = 4008;
    const planId = 380;
    
    // Get route details
    const [routeData] = await conn.query(
      `SELECT * FROM dvi_itinerary_route_details WHERE itinerary_route_ID = ?`,
      [routeId]
    );
    const route = routeData[0];
    
    console.log('=== DAY 4 ROUTE DETAILS ===');
    console.log(`Route ID: ${routeId}`);
    console.log(`Location ID: ${route.location_id}`);
    console.log(`Location Name: ${route.location_name}`);
    console.log(`Route Date: ${route.itinerary_route_date}`);
    console.log(`Route Start: ${route.route_start_time}, Route End: ${route.route_end_time}`);
    console.log(`No of KM: ${route.no_of_km}`);
    
    // Get location details
    const [locData] = await conn.query(
      `SELECT * FROM dvi_stored_locations WHERE location_ID = ?`,
      [route.location_id]
    );
    const loc = locData[0];
    
    console.log('\n=== LOCATION DETAILS ===');
    console.log(`Source Location: ${loc.source_location}`);
    console.log(`Destination Location: ${loc.destination_location}`);
    console.log(`Source City ID: ${loc.source_city_id}, Dest City ID: ${loc.destination_city_id}`);
    
    // Get all hotspots in the location cities
    const [hotspotsInCities] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_priority FROM dvi_hotspot_place
       WHERE (city_ID = ? OR city_ID = ?) AND deleted = 0 AND status = 1
       ORDER BY hotspot_priority DESC`,
      [loc.source_city_id, loc.destination_city_id]
    );
    
    console.log('\n=== HOTSPOT POOL ===');
    console.log(`Total hotspots in these cities: ${hotspotsInCities.length}`);
    
    // Get excluded hotspots
    const [planData] = await conn.query(
      `SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ?`,
      [planId]
    );
    const excludedStr = planData[0]?.excluded_hotspot_ids || '';
    const excluded = excludedStr ? excludedStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
    
    console.log(`Excluded IDs: ${excluded.length}`);
    if (excluded.length > 0 && excluded.length < 20) {
      console.log(`  [${excluded.join(', ')}]`);
    }
    
    // Get used hotspots across the plan
    const [usedHotspots] = await conn.query(
      `SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details 
       WHERE itinerary_plan_ID = ? AND itinerary_route_ID != ? AND deleted = 0 AND status = 1 AND item_type = 4`,
      [planId, routeId]
    );
    const usedElsewhere = new Set(usedHotspots.map(h => h.hotspot_ID));
    
    console.log(`Used on other days: ${usedElsewhere.size}`);
    
    // Calculate eligible
    const eligible = hotspotsInCities.filter(h => !excluded.includes(h.hotspot_ID) && !usedElsewhere.has(h.hotspot_ID));
    
    console.log('\n=== ELIGIBLE FOR DAY 4 ===');
    console.log(`Total eligible: ${eligible.length}`);
    console.log('\nList:');
    eligible.forEach((h, i) => {
      console.log(`  ${i+1}. ${h.hotspot_name} (ID: ${h.hotspot_ID}, Priority: ${h.hotspot_priority})`);
    });
    
    // Currently scheduled
    const [scheduled] = await conn.query(
      `SELECT h.hotspot_ID, p.hotspot_name FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4`,
      [routeId]
    );
    
    console.log('\n=== CURRENTLY SCHEDULED FOR DAY 4 ===');
    console.log(`Count: ${scheduled.length}`);
    scheduled.forEach((h, i) => {
      console.log(`  ${i+1}. ${h.hotspot_name} (ID: ${h.hotspot_ID})`);
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
