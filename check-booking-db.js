// Simple database check to verify bookings are working
const mysql = require('mysql2/promise');

async function checkBookingStatus() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  console.log('\n✅ Connected to database dvi_main');
  
  try {
    // Show recent plans
    console.log('\n[RECENT PLANS] Last 10 plans created:');
    const [plans] = await connection.execute(`
      SELECT 
        itinerary_plan_ID,
        quotation_status,
        createdon,
        updatedon
      FROM dvi_itinerary_plan_details
      ORDER BY createdon DESC
      LIMIT 10
    `);

    console.table(plans.map(p => ({
      ID: p.itinerary_plan_ID,
      'Status': p.quotation_status === 1 ? '✅ CONFIRMED' : '⏳ DRAFT',
      'Created': new Date(p.createdon).toLocaleString(),
      'Updated': new Date(p.updatedon).toLocaleString()
    })));

    // Check TBO bookings
    console.log('\n[TBO BOOKINGS] Recent confirmations:');
    const [tbo] = await connection.execute(`
      SELECT 
        itinerary_plan_ID,
        hotel_name,
        booking_confirmation_number,
        status,
        createdon
      FROM tbo_hotel_booking_confirmation
      ORDER BY createdon DESC
      LIMIT 5
    `);

    if (tbo.length === 0) {
      console.log('  (No TBO bookings yet)');
    } else {
      console.table(tbo.map(t => ({
        'Plan': t.itinerary_plan_ID,
        'Hotel': t.hotel_name ? t.hotel_name.substring(0, 30) : '?',
        'Confirmation': t.booking_confirmation_number,
        'Status': t.status === 1 ? '✅' : '❌',
        'Created': new Date(t.createdon).toLocaleString()
      })));
    }

    console.log('\n✅ BOOKING API IS WORKING if you see confirmed plans above');
    console.log('   (quotation_status = 1 means quote was successfully confirmed)\n');

  } catch (error) {
    console.error('❌ Database error:', error.message);
  } finally {
    await connection.end();
  }
}

checkBookingStatus().catch(console.error);
