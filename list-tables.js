// Check what tables exist
const mysql = require('mysql2/promise');

async function listTables() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    const [tables] = await connection.execute('SHOW TABLES LIKE "%.table%"');
    console.log('\nAvailable tables:');
    console.log(tables);

    // Get columns from specific table
    const [cols] = await connection.execute('DESC dvi_itinerary_plan_details');
    console.log('\nColumns in dvi_itinerary_plan_details:');
    cols.forEach(c => console.log(`  - ${c.Field}: ${c.Type}`));

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

listTables();
