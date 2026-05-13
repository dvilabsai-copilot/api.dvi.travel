const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });
    
    const [cols] = await conn.query('DESCRIBE dvi_itinerary_route_hotspot_details');
    console.log('Columns:');
    cols.forEach(c => console.log(`  ${c.Field}`));
    
    console.log('\nRoute 4013 scheduled items:');
    const [items] = await conn.query(
      `SELECT * FROM dvi_itinerary_route_hotspot_details
       WHERE itinerary_route_ID = 4013 AND deleted = 0 AND status = 1
       ORDER BY route_hotspot_order`
    );
    
    items.forEach(item => {
      console.log(`  Item: Type=${item.item_type}, HotspotID=${item.hotspot_ID}, Order=${item.route_hotspot_order}`);
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
