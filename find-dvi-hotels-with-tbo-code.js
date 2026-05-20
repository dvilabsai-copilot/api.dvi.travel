/**
 * Script to find dvi_hotel records that have tbo_hotel_code set
 * Run with: node find-dvi-hotels-with-tbo-code.js
 */

const mysql = require('mysql2/promise');

async function main() {
  // Get database credentials from environment
  const dbConfig = {
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  };

  console.log('Connecting to database...');
  const connection = await mysql.createConnection(dbConfig);

  try {
    // Query dvi_hotels with tbo_hotel_code
    console.log('\n=== Finding dvi_hotel records with tbo_hotel_code ===\n');
    
    const [hotels] = await connection.execute(`
      SELECT 
        hotel_id,
        hotel_name,
        hotel_code,
        tbo_hotel_code,
        tbo_city_code,
        hotel_city,
        hotel_category,
        status,
        deleted
      FROM dvi_hotel 
      WHERE tbo_hotel_code IS NOT NULL 
        AND tbo_hotel_code != ''
        AND deleted = 0
      ORDER BY hotel_id DESC
      LIMIT 100
    `);

    console.log(`Found ${hotels.length} dvi_hotel records with tbo_hotel_code:\n`);
    
    if (hotels.length > 0) {
      console.table(hotels.map(h => ({
        hotel_id: h.hotel_id,
        hotel_name: h.hotel_name?.substring(0, 40) || '',
        hotel_code: h.hotel_code || '',
        tbo_hotel_code: h.tbo_hotel_code || '',
        tbo_city_code: h.tbo_city_code || '',
        city: h.hotel_city || '',
        category: h.hotel_category || '',
      })));
    }

    // Also show summary by tbo_city_code
    console.log('\n=== Summary by tbo_city_code ===\n');
    const [summary] = await connection.execute(`
      SELECT 
        tbo_city_code,
        COUNT(*) as count
      FROM dvi_hotel 
      WHERE tbo_hotel_code IS NOT NULL 
        AND tbo_hotel_code != ''
        AND deleted = 0
      GROUP BY tbo_city_code
      ORDER BY count DESC
    `);
    
    console.table(summary);

    // Show total count
    const [totalResult] = await connection.execute(`
      SELECT COUNT(*) as total
      FROM dvi_hotel 
      WHERE tbo_hotel_code IS NOT NULL 
        AND tbo_hotel_code != ''
        AND deleted = 0
    `);
    
    console.log(`\nTotal dvi_hotel records with tbo_hotel_code: ${totalResult[0].total}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await connection.end();
  }
}

main();
