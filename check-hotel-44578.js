// Search for hotel 44578
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main'
  });

  try {
    console.log('\n🔍 Searching for hotel 44578 in different ways:\n');
    
    // Check if it exists with that hotel_id
    let [rows] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled, deleted FROM dvi_hotel WHERE hotel_id = 44578'
    );
    console.log('By hotel_id = 44578:', rows.length ? rows[0] : 'NOT FOUND');
    
    // Check if there's any hotel with similar property ID pattern
    [rows] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled, deleted FROM dvi_hotel WHERE axisrooms_property_id LIKE ?',
      ['%44578%']
    );
    console.log('\nBy property_id LIKE %44578%:', rows.length ? rows : 'NOT FOUND');
    
    // Check if it was deleted
    [rows] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, deleted FROM dvi_hotel WHERE hotel_id = 44578 OR axisrooms_property_id LIKE ?',
      ['%44578%']
    );
    console.log('\nWith any status (including deleted):', rows.length ? rows : 'NOT FOUND');
    
    // List hotels with no axisrooms_property_id
    [rows] = await c.execute(
      'SELECT COUNT(*) as count FROM dvi_hotel WHERE axisrooms_property_id IS NULL OR axisrooms_property_id = ""'
    );
    console.log('\nHotels without axisrooms_property_id:', rows[0].count);
    
    // List all axisrooms-enabled hotels  
    [rows] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id FROM dvi_hotel WHERE axisrooms_enabled = 1 AND deleted = 0 LIMIT 10'
    );
    console.log('\n✅ Active AxisRooms hotels (first 10):');
    rows.forEach(r => console.log('  ', r.hotel_id, '-', r.hotel_name, '-', r.axisrooms_property_id));
    
  } finally {
    await c.end();
  }
})();
