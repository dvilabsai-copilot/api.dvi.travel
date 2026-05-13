// Check AxisRooms property IDs
const mysql = require('mysql2/promise');

async function checkProperties() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    console.log('\n✅ AXISROOMS PROPERTY CHECK');
    console.log('='.repeat(80));

    // Check specific property IDs
    const propertyIds = ['AX_DVI_HOTEL_44578', 'AX_DVI_HOTEL_153'];
    
    for (const propId of propertyIds) {
      console.log(`\n📌 Property ID: ${propId}`);
      const [hotels] = await connection.execute(`
        SELECT 
          hotel_id,
          hotel_name,
          hotel_code,
          axisrooms_property_id,
          axisrooms_enabled,
          deleted
        FROM dvi_hotel 
        WHERE axisrooms_property_id = ?
      `, [propId]);

      if (hotels.length === 0) {
        console.log('   ❌ NOT FOUND in database');
      } else {
        const h = hotels[0];
        console.log(`   ID: ${h.hotel_id}`);
        console.log(`   Name: ${h.hotel_name}`);
        console.log(`   Code: ${h.hotel_code}`);
        console.log(`   axisrooms_property_id: ${h.axisrooms_property_id}`);
        console.log(`   axisrooms_enabled: ${h.axisrooms_enabled}`);
        console.log(`   deleted: ${h.deleted}`);
        
        // Check the conditions used in getProductInfo
        const shouldMatch = h.axisrooms_enabled === 1 && h.deleted !== true;
        console.log(`   ✓ Would match query: ${shouldMatch ? 'YES' : 'NO'}`);
        
        if (!shouldMatch) {
          if (h.axisrooms_enabled !== 1) {
            console.log(`     └─ Issue: axisrooms_enabled is ${h.axisrooms_enabled}, needs to be 1`);
          }
          if (h.deleted === true) {
            console.log(`     └─ Issue: Hotel is marked as deleted`);
          }
        }

        // If it matches, check if it has rooms
        if (shouldMatch) {
          const [rooms] = await connection.execute(`
            SELECT COUNT(*) as room_count
            FROM dvi_hotel_rooms
            WHERE hotel_id = ? AND deleted = 0 AND status = 1
          `, [h.hotel_id]);
          console.log(`   Rooms (active): ${rooms[0].room_count}`);
        }
      }
    }

    console.log('\n' + '='.repeat(80));

  } finally {
    await connection.end();
  }
}

checkProperties().catch(console.error);
