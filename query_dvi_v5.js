const axios = require('axios');
const mysql = require('mysql2/promise');
const fs = require('fs');
async function run() {
    try {
        const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzgyOTI5NjksImV4cCI6MTc3ODg5Nzc2OX0.T8O8Gx5u4tplHXM7pVxgWZIQuKgvGVAZLfxdiYP64i4';
        const url = 'http://127.0.0.1:4006/api/v1/itineraries/details/DVI20260588';
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        console.log('GET STATUS:', res.status);
        fs.writeFileSync('dvi20260588_details_live.json', JSON.stringify(res.data, null, 2));
        const body = res.data.data;
        if (body && body.days) {
            body.days.forEach(day => {
                const placeholders = day.segments ? day.segments.filter(s => s.hotspot_name === 'Click to Add Hotspot').length : 0;
                console.log(`Day ${day.day_number} (${day.date}): ${day.segments ? day.segments.length : 0} segments, ${placeholders} placeholders`);
            });
        }
        const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
        const [plans] = await conn.query('SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_code = "DVI20260588"');
        if (plans.length === 0) { console.log('Plan not found in DB'); await conn.end(); return; }
        const planId = plans[0].itinerary_plan_ID;
        console.log('Plan ID:', planId);
        const [routes] = await conn.query('SELECT itinerary_route_ID, itinerary_route_date, location_name FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_route_ID', [planId]);
        console.log('Routes:');
        routes.forEach((r, i) => console.log(`  Day ${i+1}: ID ${r.itinerary_route_ID}, ${r.itinerary_route_date}, ${r.location_name}`));
        const [counts] = await conn.query(
            'SELECT itinerary_route_ID, item_type, COUNT(*) as count FROM dvi_itinerary_route_hotspot_details ' +
            'WHERE itinerary_plan_ID = ? AND deleted = 0 AND status = 1 GROUP BY itinerary_route_ID, item_type', [planId]
        );
        console.log('Item Counts:');
        counts.forEach(c => console.log(`  Route ${c.itinerary_route_ID}, Type ${c.item_type}: ${c.count}`));
        await conn.end();
    } catch (e) {
        console.error('Error:', e.message);
        if (e.response && e.response.data) console.error('Data:', JSON.stringify(e.response.data));
    }
}
run();
