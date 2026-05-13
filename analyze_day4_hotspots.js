const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    const planId = 380;
    const routeId = 4008;
    
    const [routeRows] = await conn.query(
      'SELECT location_id, location_name FROM dvi_itinerary_route_details WHERE itinerary_route_ID = ?',
      [routeId]
    );
    const route = routeRows[0];
    
    const [locRows] = await conn.query(
      'SELECT * FROM dvi_stored_locations WHERE location_ID = ?',
      [route.location_id]
    );
    const loc = locRows[0];
    
    console.log('Route ' + routeId + ': ' + route.location_name);
    console.log('Source city: ' + loc.source_city_id + ', Dest city: ' + loc.destination_city_id);
    
    const [allHotspots] = await conn.query(
      'SELECT hotspot_ID, hotspot_name, hotspot_priority FROM dvi_hotspot_place WHERE (city_ID = ? OR city_ID = ?) AND deleted = 0 AND status = 1 ORDER BY hotspot_priority DESC',
      [loc.source_city_id, loc.destination_city_id]
    );
    
    console.log('\nTotal hotspots in source/dest cities: ' + allHotspots.length);
    
    const [planRows] = await conn.query(
      'SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ?',
      [planId]
    );
    const excludedStr = planRows[0]?.excluded_hotspot_ids || '';
    const excluded = excludedStr ? excludedStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
    
    console.log('Excluded hotspots: ' + excluded.length + ' IDs');
    
    const [usedRows] = await conn.query(
      'SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plan_ID = ? AND deleted = 0 AND status = 1 AND item_type = 4',
      [planId]
    );
    const used = new Set(usedRows.map(h => h.hotspot_ID));
    
    console.log('Used hotspots: ' + used.size);
    
    const eligible = allHotspots.filter(h => !excluded.includes(h.hotspot_ID) && !used.has(h.hotspot_ID));
    console.log('Eligible for day 4: ' + eligible.length);
    
    if (eligible.length > 0) {
      console.log('\nTop 10 eligible hotspots (by priority):');
      eligible.slice(0, 10).forEach((h, i) => {
        console.log('  ' + (i+1) + '. ' + h.hotspot_name + ' (ID: ' + h.hotspot_ID + ', Priority: ' + h.hotspot_priority + ')');
      });
    }
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
