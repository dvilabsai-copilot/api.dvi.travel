const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env')) {
    const envConfig = dotenv.parse(fs.readFileSync('.env'));
    for (const k in envConfig) { process.env[k] = envConfig[k]; }
}

(async () => {
  try {
    const conn = await mysql.createConnection({
        host: 'localhost',
        user: 'dvi_user',
        password: 'myDvi123!',
        database: 'dvi_main'
    });

    const routeId = 4013;
    const planId = 380;

    console.log(`1. Deleting hotspots from route ${routeId}...`);
    const [delResult] = await conn.query(
      `DELETE FROM dvi_itinerary_route_hotspot_details WHERE itinerary_route_ID = ? AND deleted = 0`,
      [routeId]
    );
    console.log(`   Deleted ${delResult.affectedRows} rows.`);

    console.log(`2. Generating JWT token...`);
    const jwtSecret = process.env.JWT_SECRET || 'your-default-secret';
    const token = jwt.sign({ sub: "1", email: "admin@dvi.co.in", role: 1 }, jwtSecret);

    console.log(`3. Calling rebuild endpoint...`);
    try {
        await axios.post(`http://localhost:4006/api/v1/itineraries/${planId}/route/${routeId}/rebuild`, {}, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`   Rebuild call successful.`);
    } catch (err) {
        console.error(`   Rebuild failed: ${err.message}`);
        if (err.response) console.error(`   Response: ${JSON.stringify(err.response.data)}`);
    }

    console.log(`4. Final count and listing...`);
    const [hotspots] = await conn.query(
      `SELECT h.hotspot_ID, p.hotspot_name FROM dvi_itinerary_route_hotspot_details h
       LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
       WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4
       ORDER BY h.route_hotspot_order`,
      [routeId]
    );

    console.log(`\nNew Hotspot Count: ${hotspots.length}`);
    hotspots.forEach((h, i) => {
      console.log(`  ${i+1}. ${h.hotspot_name} (ID: ${h.hotspot_ID})`);
    });

    await conn.end();
  } catch (e) {
    console.error(e);
  }
})();
