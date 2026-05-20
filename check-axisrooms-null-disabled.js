// Count hotels with null axisrooms_property_id and axisrooms_enabled = 0
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main'
  });

  try {
    const [rows] = await c.execute(
      'SELECT COUNT(*) as count FROM dvi_hotel WHERE axisrooms_property_id IS NULL AND axisrooms_enabled = 0'
    );
    
    console.log('\n📊 Hotels with axisrooms_property_id = NULL AND axisrooms_enabled = 0:');
    console.log('   Count:', rows[0].count);
    
    // Show a few examples
    const [examples] = await c.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled FROM dvi_hotel WHERE axisrooms_property_id IS NULL AND axisrooms_enabled = 0 LIMIT 5'
    );
    
    console.log('\n📋 Examples:');
    examples.forEach(h => {
      console.log(`   ID: ${h.hotel_id}, Name: ${h.hotel_name}, axisrooms_enabled: ${h.axisrooms_enabled}`);
    });
    
  } finally {
    await c.end();
  }
})();
