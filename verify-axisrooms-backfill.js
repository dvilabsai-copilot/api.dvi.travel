// Verify the backfill worked
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main'
  });

  try {
    console.log('\n✅ VERIFICATION - AxisRooms productInfo would now work for:');
    console.log('='.repeat(70));
    
    // Check hotel 44578 specifically
    const [h44578] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled, deleted FROM dvi_hotel WHERE hotel_id = 44578'
    );
    if (h44578.length) {
      const h = h44578[0];
      console.log(`\nHotel 44578: ${h.hotel_name}`);
      console.log(`  axisrooms_property_id: ${h.axisrooms_property_id}`);
      console.log(`  axisrooms_enabled: ${h.axisrooms_enabled}`);
      console.log(`  deleted: ${h.deleted}`);
      const wouldPass = h.axisrooms_enabled === 1 && h.deleted !== true;
      console.log(`  ✅ Would now pass productInfo query: ${wouldPass ? 'YES' : 'NO'}`);
    }
    
    // Check hotel 153
    const [h153] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled, deleted FROM dvi_hotel WHERE hotel_id = 153'
    );
    if (h153.length) {
      const h = h153[0];
      console.log(`\nHotel 153: ${h.hotel_name}`);
      console.log(`  axisrooms_property_id: ${h.axisrooms_property_id}`);
      console.log(`  axisrooms_enabled: ${h.axisrooms_enabled}`);
      console.log(`  deleted: ${h.deleted}`);
    }
    
    // Show stats
    const [stats] = await c.execute(
      'SELECT COUNT(*) as total, SUM(CASE WHEN axisrooms_enabled = 1 THEN 1 ELSE 0 END) as enabled FROM dvi_hotel WHERE deleted = 0'
    );
    console.log(`\n📊 Statistics:`);
    console.log(`  Total active hotels: ${stats[0].total}`);
    console.log(`  AxisRooms enabled: ${stats[0].enabled}`);

    console.log('\n' + '='.repeat(70) + '\n');
    
  } finally {
    await c.end();
  }
})();
