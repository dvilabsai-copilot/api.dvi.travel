const mysql = require('mysql2/promise');
(async () => {
  try {
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
    
    console.log('=== CHECKING DATABASE FOR HOTEL 153 CP_PLAN OCCUPANCY ===\n');
    
    const [rates] = await conn.query(`
      SELECT 
        occupancy_id, 
        hotel_id, 
        room_id, 
        rateplan_id, 
        occupancy_rates,
        created_at,
        updated_at
      FROM dvi_hotel_occupancy_rate
      WHERE hotel_id = 153 
        AND room_id = 189
        AND rateplan_id LIKE '%CP_PLAN%'
      ORDER BY created_at DESC
      LIMIT 5
    `);
    
    console.log(`Total CP_PLAN rows for hotel 153, room 189: ${rates.length}\n`);
    
    rates.forEach((r, i) => {
      const occ = typeof r.occupancy_rates === 'string' ? JSON.parse(r.occupancy_rates) : r.occupancy_rates;
      console.log(`Row ${i+1}:`);
      console.log(`  ID: ${r.occupancy_id}`);
      console.log(`  RatePlan: ${r.rateplan_id}`);
      console.log(`  Rates: ${JSON.stringify(occ)}`);
      console.log(`  Updated: ${r.updated_at}`);
      console.log();
    });
    
    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
