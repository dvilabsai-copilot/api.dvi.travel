// Check column names for provider tables
const mysql = require('mysql2/promise');

async function checkColumns() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    const tables = [
      'tbo_hotel_booking_confirmation',
      'resavenue_hotel_booking_confirmation',
      'hobse_hotel_booking_confirmation'
    ];

    for (const table of tables) {
      console.log(`\n📋 Columns in ${table}:`);
      const [cols] = await connection.execute(`DESC ${table}`);
      cols.forEach(c => {
        console.log(`   - ${c.Field}`);
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

checkColumns();
