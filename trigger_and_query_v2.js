const jwt = require('jsonwebtoken');
const axios = require('axios');
const mysql = require('mysql2/promise');

async function run() {
    try {
        const token = jwt.sign({ sub: '1', email: 'admin@dvi.co.in', role: 1, agentId: 0, staffId: 0, guideId: 0 }, 'Zk7qT2pL9vB3xM6sG1yR4wN8hC5dK0jF2uV7aP3rX9mL4tQ');
        const planId = 380;
        const routeId = 4073;

        console.log('Sending rebuild request...');
        const response = await axios.post('http://127.0.0.1:4006/api/v1/itineraries/' + planId + '/route/' + routeId + '/rebuild', {}, {
            headers: { Authorization: 'Bearer ' + token }
        });
        console.log('Rebuild Status:', response.status);

        const conn = await mysql.createConnection({ host: 'localhost', user: 'dvi_user', password: 'myDvi123!', database: 'dvi_main' });
        const [rows] = await conn.query(
            'SELECT h.hotspot_ID, p.hotspot_name, h.arrival_time, h.departure_time, h.route_hotspot_order ' +
            'FROM dvi_itinerary_route_hotspot_details h ' +
            'LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID ' +
            'WHERE h.itinerary_route_ID = ? AND h.item_type = 4 AND h.deleted = 0 AND h.status = 1 ' +
            'ORDER BY h.route_hotspot_order', [routeId]
        );
        console.log('FINAL_HOTSPOTS:' + JSON.stringify(rows));
        await conn.end();
    } catch (err) {
        console.error('Error:', err.message);
        if (err.response) console.error('Response:', JSON.stringify(err.response.data));
    }
}
run();
