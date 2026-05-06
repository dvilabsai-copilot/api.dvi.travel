const mysql = require('mysql2/promise');
(async () => {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
  
  // Find itineraries with routes in ResAvenue cities
  const [rows] = await conn.query(
    "SELECT DISTINCT i.itinerary_id, i.itinerary_name, r.destination, r.route_date " +
    "FROM dvi_itinerary i " +
    "JOIN dvi_route r ON r.itinerary_id = i.itinerary_id " +
    "WHERE r.destination IN ('Madurai','Mumbai','Thrissur','Vellore','Kumbakonam','Rameswaram','Uthagamandalam','Darjiling','Gwalior') " +
    "AND i.deleted = 0 " +
    "ORDER BY i.itinerary_id DESC LIMIT 20"
  );
  console.log('Itineraries with ResAvenue cities:');
  if (rows.length === 0) {
    console.log('  None found. Checking all destinations in routes...');
    const [dests] = await conn.query(
      "SELECT DISTINCT destination FROM dvi_route ORDER BY destination LIMIT 50"
    );
    console.log('Available destinations:', dests.map(d => d.destination).join(', '));
  }
  rows.forEach(r => console.log(JSON.stringify(r)));
  
  await conn.end();
})().catch(e => console.error(e.message));
