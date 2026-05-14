// Sync hotel 44578 from production to local
const mysql = require('mysql2/promise');

async function syncHotel44578() {
  const prodConnection = await mysql.createConnection({
    host: '134.209.145.185',
    user: 'root',
    password: '8UMmdX#44PId#tdJ',
    database: 'dvi_main',
  });

  const localConnection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    console.log('\n📊 SYNCING HOTEL 44578 FROM PRODUCTION TO LOCAL');
    console.log('='.repeat(80));

    // Get production data
    console.log('\n1️⃣  Fetching hotel 44578 from production...');
    const [prodHotels] = await prodConnection.execute(
      'SELECT * FROM dvi_hotel WHERE hotel_id = 44578'
    );

    if (prodHotels.length === 0) {
      console.log('   ❌ Hotel not found in production');
      return;
    }

    const prodHotel = prodHotels[0];
    console.log(`   ✅ Found: ${prodHotel.hotel_name}`);
    console.log(`      - axisrooms_property_id: ${prodHotel.axisrooms_property_id}`);
    console.log(`      - axisrooms_enabled: ${prodHotel.axisrooms_enabled}`);

    // Update local database
    console.log('\n2️⃣  Updating local hotel 44578...');
    const [result] = await localConnection.execute(
      `UPDATE dvi_hotel 
       SET hotel_name = ?,
           hotel_code = ?,
           tbo_hotel_code = ?,
           tbo_city_code = ?,
           resavenue_hotel_code = ?,
           hotel_mobile = ?,
           hotel_email = ?,
           hotel_country = ?,
           hotel_city = ?,
           hotel_state = ?,
           hotel_place = ?,
           hotel_address = ?,
           hotel_pincode = ?,
           hotel_margin = ?,
           hotel_margin_gst_type = ?,
           hotel_margin_gst_percentage = ?,
           hotel_longitude = ?,
           hotel_latitude = ?,
           hotel_category = ?,
           hotel_cancel_policy = ?,
           hotel_power_backup = ?,
           hotel_free_cancel_policy_no_of_days_from_booking_date = ?,
           hotel_cancel_policy_percentage = ?,
           hotel_hotspot_status = ?,
           axisrooms_property_id = ?,
           axisrooms_enabled = ?,
           staah_property_id = ?,
           staah_enabled = ?,
           status = ?,
           updatedon = NOW()
       WHERE hotel_id = 44578`,
      [
        prodHotel.hotel_name,
        prodHotel.hotel_code,
        prodHotel.tbo_hotel_code,
        prodHotel.tbo_city_code,
        prodHotel.resavenue_hotel_code,
        prodHotel.hotel_mobile,
        prodHotel.hotel_email,
        prodHotel.hotel_country,
        prodHotel.hotel_city,
        prodHotel.hotel_state,
        prodHotel.hotel_place,
        prodHotel.hotel_address,
        prodHotel.hotel_pincode,
        prodHotel.hotel_margin,
        prodHotel.hotel_margin_gst_type,
        prodHotel.hotel_margin_gst_percentage,
        prodHotel.hotel_longitude,
        prodHotel.hotel_latitude,
        prodHotel.hotel_category,
        prodHotel.hotel_cancel_policy,
        prodHotel.hotel_power_backup,
        prodHotel.hotel_free_cancel_policy_no_of_days_from_booking_date,
        prodHotel.hotel_cancel_policy_percentage,
        prodHotel.hotel_hotspot_status,
        prodHotel.axisrooms_property_id,
        prodHotel.axisrooms_enabled,
        prodHotel.staah_property_id,
        prodHotel.staah_enabled,
        prodHotel.status,
      ]
    );

    console.log(`   ✅ Updated ${result.affectedRows} hotel record`);

    // Verify
    console.log('\n3️⃣  Verifying local sync...');
    const [localHotels] = await localConnection.execute(
      'SELECT hotel_id, hotel_name, axisrooms_property_id, axisrooms_enabled FROM dvi_hotel WHERE hotel_id = 44578'
    );

    if (localHotels.length > 0) {
      const localHotel = localHotels[0];
      console.log(`   ✅ Local hotel 44578: ${localHotel.hotel_name}`);
      console.log(`      - axisrooms_property_id: ${localHotel.axisrooms_property_id}`);
      console.log(`      - axisrooms_enabled: ${localHotel.axisrooms_enabled}`);
      
      if (localHotel.axisrooms_property_id === prodHotel.axisrooms_property_id &&
          localHotel.axisrooms_enabled === prodHotel.axisrooms_enabled) {
        console.log('\n   ✅ SYNC SUCCESSFUL');
      }
    }

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    throw error;
  } finally {
    await prodConnection.end();
    await localConnection.end();
  }
}

syncHotel44578().catch(err => {
  console.error(err);
  process.exit(1);
});
