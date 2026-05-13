/**
 * Backfill AxisRooms Integration Settings
 * 
 * Fixes:
 * 1. Sets axisrooms_property_id to AX_DVI_HOTEL_{hotel_id} for hotels where it's NULL
 * 2. Sets axisrooms_enabled = 1 for all hotels where it's 0
 * 
 * Usage: node backfill-axisrooms-settings.js
 */

const mysql = require('mysql2/promise');

async function backfillAxisRoomsSettings() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    console.log('\n📋 AXISROOMS SETTINGS BACKFILL');
    console.log('='.repeat(80));

    // Step 1: Update hotels with NULL axisrooms_property_id
    console.log('\n1️⃣  Updating hotels with NULL axisrooms_property_id...');
    
    // First, find all hotels with NULL axisrooms_property_id
    const [hotelsWithNullId] = await connection.execute(
      'SELECT hotel_id FROM dvi_hotel WHERE axisrooms_property_id IS NULL OR axisrooms_property_id = ""'
    );
    
    console.log(`   Found ${hotelsWithNullId.length} hotels with missing property ID`);
    
    if (hotelsWithNullId.length > 0) {
      for (const hotel of hotelsWithNullId) {
        const propertyId = `AX_DVI_HOTEL_${hotel.hotel_id}`;
        await connection.execute(
          'UPDATE dvi_hotel SET axisrooms_property_id = ? WHERE hotel_id = ?',
          [propertyId, hotel.hotel_id]
        );
      }
      console.log(`   ✅ Updated ${hotelsWithNullId.length} hotels with property IDs`);
    }

    // Step 2: Enable AxisRooms for all hotels
    console.log('\n2️⃣  Enabling AxisRooms (setting axisrooms_enabled = 1)...');
    
    const [result] = await connection.execute(
      'UPDATE dvi_hotel SET axisrooms_enabled = 1 WHERE axisrooms_enabled = 0 AND deleted = 0'
    );
    
    console.log(`   ✅ Enabled ${result.affectedRows} hotels`);

    // Step 3: Verify the changes
    console.log('\n3️⃣  Verification...');
    
    const [stillNull] = await connection.execute(
      'SELECT COUNT(*) as count FROM dvi_hotel WHERE axisrooms_property_id IS NULL OR axisrooms_property_id = ""'
    );
    console.log(`   Hotels with missing property ID: ${stillNull[0].count}`);

    const [stillDisabled] = await connection.execute(
      'SELECT COUNT(*) as count FROM dvi_hotel WHERE axisrooms_enabled = 0 AND deleted = 0'
    );
    console.log(`   Active hotels with AxisRooms disabled: ${stillDisabled[0].count}`);

    const [verified] = await connection.execute(
      'SELECT COUNT(*) as count FROM dvi_hotel WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != "" AND axisrooms_enabled = 1 AND deleted = 0'
    );
    console.log(`   ✅ Hotels properly configured: ${verified[0].count}`);

    // Show a few examples
    const [examples] = await connection.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled FROM dvi_hotel WHERE axisrooms_enabled = 1 LIMIT 5'
    );
    console.log('\n📊 Sample of updated hotels:');
    examples.forEach(h => {
      console.log(`   ID: ${h.hotel_id}, ${h.hotel_name}, axisrooms_property_id: ${h.axisrooms_property_id}`);
    });

    console.log('\n' + '='.repeat(80));
    console.log('✅ BACKFILL COMPLETE\n');

  } catch (error) {
    console.error('❌ Error during backfill:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

backfillAxisRoomsSettings().catch(err => {
  console.error(err);
  process.exit(1);
});
