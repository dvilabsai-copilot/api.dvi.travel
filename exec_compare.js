const axios = require('axios');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const payload = {
    fixed_start: 1,
    fixed_end: 1,
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [{ room_id: 1, traveller_type: 1 }],
    routes: [
        { location_name: 'Bangalore', next_visiting_location: 'Mysore', itinerary_route_date: '2026-05-14', no_of_days: 1, direct_to_next_visiting_place: 0 },
        { location_name: 'Mysore', next_visiting_location: 'Ooty', itinerary_route_date: '2026-05-15', no_of_days: 1, direct_to_next_visiting_place: 0 },
        { location_name: 'Ooty', next_visiting_location: 'Coimbatore', itinerary_route_date: '2026-05-16', no_of_days: 1, direct_to_next_visiting_place: 0 },
        { location_name: 'Coimbatore', next_visiting_location: 'Bangalore', itinerary_route_date: '2026-05-17', no_of_days: 1, direct_to_next_visiting_place: 0 }
    ]
};

async function run() {
    try {
        const token = jwt.sign({ sub: '1', email: 'admin@dvi.co.in', role: 1 }, 'Zk7qT2pL9vB3xM6sG1yR4wN8hC5dK0jF2uV7aP3rX9mL4tQ');
        
        console.log('--- NEST API CALL ---');
        try {
            const response = await axios.post('http://127.0.0.1:4006/api/v1/itineraries/?type=itineary_basic_info_with_optimized_route', payload, {
                headers: { Authorization: 'Bearer ' + token }
            });
            console.log('Nest Status:', response.status);
            const nestRoutes = response.data.data.routes || [];
            const nestChain = nestRoutes.map(r => r.location_name + ' -> ' + r.next_visiting_location).join(', ');
            console.log('Nest Chain:', nestChain);
        } catch (e) {
            console.log('Nest Failed:', e.message);
        }

        console.log('\n--- PHP EMULATION ---');
        const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
        
        // 1. Get cities
        const sources = payload.routes.map(r => r.location_name);
        const nexts = payload.routes.map(r => r.next_visiting_location);
        const start = sources[0];
        const end = nexts[nexts.length - 1];
        const cities = Array.from(new Set([...sources, ...nexts]));

        // 2. Fetch Distances
        const [distRows] = await conn.query(
            'SELECT source_location, destination_location, distance_km FROM dvi_hotspot_distance_cache WHERE source_location IN (?) AND destination_location IN (?) AND deleted = 0',
            [cities, cities]
        );
        
        const distMap = {};
        distRows.forEach(row => {
            const s = row.source_location;
            const d = row.destination_location;
            if (!distMap[s]) distMap[s] = {};
            distMap[s][d] = parseFloat(row.distance_km);
        });

        // 3. Optimization Logic (PHP's generateRoutes exhaustive)
        const midStops = sources.filter(s => s !== start);
        const results = [];

        function permute(arr, memo = []) {
            if (arr.length === 0) {
                let current = start;
                let totalDist = 0;
                let path = [];
                for (const stop of memo) {
                    const d = (distMap[current] && distMap[current][stop]) || 999999;
                    totalDist += d;
                    path.push({ from: current, to: stop });
                    current = stop;
                }
                const lastD = (distMap[current] && distMap[current][end]) || 999999;
                totalDist += lastD;
                path.push({ from: current, to: end });
                results.push({ path, totalDist });
            } else {
                for (let i = 0; i < arr.length; i++) {
                    let curr = arr.slice();
                    let next = curr.splice(i, 1);
                    permute(curr, memo.concat(next));
                }
            }
        }

        permute(midStops);
        results.sort((a, b) => a.totalDist - b.totalDist);
        
        if (results.length > 0) {
            const best = results[0];
            const phpChain = best.path.map(p => p.from + ' -> ' + p.to).join(', ');
            console.log('PHP Chain:', phpChain);
            console.log('PHP Distance:', best.totalDist);
        } else {
            console.log('No PHP results.');
        }

        await conn.end();
    } catch (err) {
        console.error('Script Error:', err.message);
    }
}
run();
