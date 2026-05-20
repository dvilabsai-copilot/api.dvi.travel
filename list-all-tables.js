// List all tables to find the correct provider table names
const mysql = require('mysql2/promise');

async function listAllTables() {
  const connection = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  try {
    const [tables] = await connection.execute('SHOW TABLES');
    console.log('\n📋 ALL TABLES IN DATABASE:\n');
    tables.forEach((t, i) => {
      const tableName = Object.values(t)[0];
      if (tableName.includes('booking') || tableName.includes('confirmation') || tableName.includes('hotel')) {
        console.log(`   ${tableName}`);
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

listAllTables();
