const mysql = require('mysql2/promise');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const fs = require('fs');

if (fs.existsSync('.env')) {
    const envConfig = dotenv.parse(fs.readFileSync('.env'));
    for (const k in envConfig) { process.env[k] = envConfig[k]; }
}

async function run() {
    const routeId = 4068;
    const planId = 380;
    const targetHotspots = [324, 673];
    
    try {
        const jwtSecret = process.env.JWT_SECRET || 'your-default-secret';
        const token = jwt.sign({ sub: "1", email: "admin@dvi.co.in", role: 1, agentId: 0, staffId: 0, guideId: 0 }, jwtSecret);

        await axios.post(`http://127.0.0.1:4006/api/v1/itineraries/${planId}/route/${routeId}/rebuild`, {}, {
            headers: { Authorization: `Bearer ${token}` }
        });

        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        const [rows] = await conn.query(
            `SELECT h.hotspot_ID, p.hotspot_name, h.arrival_time, h.departure_time, h.route_hotspot_order 
             FROM dvi_itinerary_route_hotspot_details h
             LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
             WHERE h.itinerary_route_ID = ? AND h.item_type = 4 AND h.deleted = 0 AND h.status = 1
             ORDER BY h.route_hotspot_order`,
            [routeId]
        );

        console.log(`Hotspots for Route ${routeId}:`);
        rows.forEach(r => console.log(`  - ID: ${r.hotspot_ID}, Name: ${r.hotspot_name}, Order: ${r.route_hotspot_order}`));

        const found = rows.filter(r => targetHotspots.includes(r.hotspot_ID)).map(r => r.hotspot_ID);
        console.log(`Targets [${targetHotspots.join(',')}] check: ${found.length > 0 ? 'Found ' + found.join(',') : 'None found'}`);

        await conn.end();
    } catch (err) {
        console.error("Error:", err.message);
    }
}
run();
