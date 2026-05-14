const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
  // Check ALL hotspot assignments for route 4108 (no priority filter)
  const [r1] = await conn.query(`SELECT h.hotspot_ID, h.hotspot_name, h.hotspot_location, h.hotspot_priority, h.visit_duration, irh.isMustVisit, irh.hotspot_plan_own_way FROM dvi_itinerary_route_hotspots irh JOIN dvi_hotspots h ON h.hotspot_ID = irh.hotspot_ID WHERE irh.itinerary_route_ID = 4108 AND irh.deleted = 0 ORDER BY irh.isMustVisit DESC, h.hotspot_priority`);
  console.log('Route 4108 all hotspots:');
  r1.forEach(r => console.log(`  ID:${r.hotspot_ID} ${r.hotspot_name} loc:${r.hotspot_location} pri:${r.hotspot_priority} mustVisit:${r.isMustVisit} own:${r.hotspot_plan_own_way}`));
  
  // Also check how many hotspots have isMustVisit=1 vs 0
  console.log('\nTotal strict (isMustVisit=1):', r1.filter(r=>r.isMustVisit==1).length);
  console.log('Total filler (isMustVisit=0):', r1.filter(r=>r.isMustVisit==0).length);
  
  await conn.end();
})().catch(console.error);
