const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
  
  // Find the PHP-generated plan (the one NOT rebuilt by NestJS, or a recent PHP reference)
  // Look for another plan with same itinerary structure (Bangalore->Coorg->Ooty)
  const [plans] = await conn.query(`
    SELECT p.itinerary_plan_ID, p.itinerary_code, p.created_at
    FROM dvi_itinerary_plan_details p
    WHERE p.itinerary_plan_ID != 380
    ORDER BY p.itinerary_plan_ID DESC LIMIT 10
  `);
  console.log('Recent other plans:');
  console.table(plans.map(p => ({ id: p.itinerary_plan_ID, code: p.itinerary_code, created: p.created_at })));
  await conn.end();
})().catch(console.error);
