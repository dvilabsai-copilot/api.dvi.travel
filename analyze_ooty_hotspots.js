const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    const planId = 380;
    const routeId = 4013; // Correct day 4 route
    
    // Get route location
    const [routeData] = await conn.query(
      `SELECT location_name FROM dvi_itinerary_route_details WHERE itinerary_route_ID = ?`,
      [routeId]
    );
    const routeName = routeData[0]?.location_name || 'Unknown';
    
    console.log(`=== DAY 4 ROUTE ${routeId}: ${routeName} ===\n`);
    
    // Get all hotspots in Ooty (since this is Ooty)
    const [ootyHotspots] = await conn.query(
      `SELECT hotspot_ID, hotspot_name, hotspot_priority FROM dvi_hotspot_place
       WHERE hotspot_location LIKE '%Ooty%' AND deleted = 0 AND status = 1
       ORDER BY hotspot_priority DESC`
    );
    
    console.log(`Total Ooty hotspots: ${ootyHotspots.length}`);
    
    // Get excluded
    const [planData] = await conn.query(
      `SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ?`,
      [planId]
    );
    const excludedStr = planData[0]?.excluded_hotspot_ids || '';
    const excluded = excludedStr ? excludedStr.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
    
    console.log(`Excluded: ${excluded.length} hotspots`);
    
    // Get used elsewhere
    const [usedOther] = await conn.query(
      `SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details
       WHERE itinerary_plan_ID = ? AND itinerary_route_ID != ? AND deleted = 0 AND status = 1 AND item_type = 4`,
      [planId, routeId]
    );
    const usedIDs = new Set(usedOther.map(h => h.hotspot_ID));
    
    console.log(`Used on other days: ${usedIDs.size} hotspots`);
    
    // Currently scheduled on day 4
    const [scheduled] = await conn.query(
      `SELECT hotspot_ID FROM dvi_itinerary_route_hotspot_details
       WHERE itinerary_route_ID = ? AND deleted = 0 AND status = 1 AND item_type = 4`,
      [routeId]
    );
    const scheduledIDs = new Set(scheduled.map(h => h.hotspot_ID));
    
    console.log(`\n=== OOTY HOTSPOT STATUS ===\n`);
    
    const eligible = [];
    ootyHotspots.forEach((h, i) => {
      const isScheduled = scheduledIDs.has(h.hotspot_ID);
      const isUsed = usedIDs.has(h.hotspot_ID);
      const isExcluded = excluded.includes(h.hotspot_ID);
      
      let status = '';
      if (isScheduled) status = '√ SCHEDULED';
      else if (isExcluded) status = '× EXCLUDED';
      else if (isUsed) status = '× USED';
      else {
        status = '○ AVAILABLE';
        eligible.push(h);
      }
      
      console.log(`${i+1}. ${h.hotspot_name.padEnd(30)} (ID: ${String(h.hotspot_ID).padEnd(3)}, Pri: ${String(h.hotspot_priority).padStart(2)}) ${status}`);
    });
    
    console.log(`\n=== SUMMARY ===`);
    console.log(`Eligible: ${eligible.length} hotspots available to schedule`);
    console.log(`Scheduled: ${scheduledIDs.size} hotspots currently on day 4`);
    console.log(`\nEligible hotspots:`);
    eligible.forEach((h, i) => {
      console.log(`  ${i+1}. ${h.hotspot_name} (ID: ${h.hotspot_ID}, Priority: ${h.hotspot_priority})`);
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
