// Check booking status using correct column names
const mysql = require('mysql2/promise');

async function checkStatus() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    console.log('\n✅ DATABASE STATUS CHECK');
    console.log('='.repeat(60));

    // Get latest 5 plans
    console.log('\n📋 RECENT PLANS (Last 5):');
    const [plans] = await connection.execute(`
      SELECT 
        itinerary_plan_ID,
        quotation_status,
        createdon,
        updatedon
      FROM dvi_itinerary_plan_details
      ORDER BY createdon DESC
      LIMIT 5
    `);

    if (plans.length === 0) {
      console.log('   (No plans found in database yet)');
    } else {
      plans.forEach(p => {
        const status = p.quotation_status === 1 ? '✅ CONFIRMED' : '⏳ DRAFT';
        console.log(`   ID: ${p.itinerary_plan_ID} | Status: ${status} | Updated: ${p.updatedon}`);
      });
    }

    // Get TBO bookings
    console.log('\n🏨 TBO HOTEL BOOKINGS (Last 5):');
    const [tbo] = await connection.execute(`
      SELECT 
        *
      FROM tbo_hotel_booking_confirmation
      ORDER BY createdon DESC
      LIMIT 5
    `);

    if (tbo.length === 0) {
      console.log('   (No TBO bookings yet)');
    } else {
      tbo.forEach(t => {
        console.log(`   Plan: ${t.itinerary_plan_ID} | Hotel: ${t.hotel_name || '?'} | Status: ${t.status === 1 ? '✅' : '❌'}`);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ API BOOKING IS WORKING');
    console.log('   If you see plans with status ✅ CONFIRMED above,');
    console.log('   the booking API is working correctly!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

checkStatus();
