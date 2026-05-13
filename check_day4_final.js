const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    // Get count
    const [countResult] = await conn.query(
      `SELECT COUNT(*) as cnt FROM dvi_itinerary_route_hotspot_details 
       WHERE itinerary_route_ID = 4008 AND deleted = 0 AND status = 1`
    );
    console.log('Total hotspots on route 4008 (day 4):', countResult[0].cnt);
    
    // Get list with names
    const [hotspots] = await conn.query(
      `SELECT h.*, p.hotspot_name 
       FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_id = p.hotspot_id
       WHERE h.itinerary_route_ID = 4008 AND h.deleted = 0 AND h.status = 1
       ORDER BY h.hotspot_position`
    );
    
    console.log('\nHotspots on Day 4:');
    hotspots.forEach((h, i) => {
      console.log(`${i+1}. ${h.hotspot_name} (ID: ${h.hotspot_id})`);
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
