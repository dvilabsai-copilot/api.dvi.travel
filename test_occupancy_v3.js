const mysql = require('mysql2/promise');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env')) {
    const envConfig = dotenv.parse(fs.readFileSync('.env'));
    for (const k in envConfig) { process.env[k] = envConfig[k]; }
}

(async () => {
    try {
        const jwtSecret = process.env.JWT_SECRET || 'your-default-secret';
        const token = jwt.sign({ sub: '1', email: 'admin@dvi.co.in', role: 1 }, jwtSecret);
        
        const hotelId = 153; 
        const roomId = 189;
        const ratePlanCode = 'CP_PLAN';
        const startDate = '2025-11-01'; // Changed to Nov to avoid overlaps
        const endDate = '2025-11-02';

        const payload = {
            items: [
                {
                    room_id: roomId,
                    startDate: startDate,
                    endDate: endDate,
                    ratePlanName: ratePlanCode, // Mapping to rate_plan_code field in DB
                    occupancyRates: {
                        SINGLE: 123
                    }
                }
            ]
        };

        console.log(`--- 1. Sending Bulk Room Pricebook Payload to /api/v1/hotels/${hotelId}/rooms/pricebook/bulk ---`);
        try {
            const response = await axios.post(`http://localhost:4006/api/v1/hotels/${hotelId}/rooms/pricebook/bulk`, payload, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log('Response status:', response.status);
            console.log('Response data:', JSON.stringify(response.data));
        } catch (err) {
            console.error('Post failed:', err.message, err.response?.data);
            return;
        }

        console.log('\n--- 2. Querying Database for Results ---');
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        const [rows] = await conn.query(
            "SELECT occupancy_date, rate_plan_code, occupancy_rates FROM dvi_hotel_occupancy_rate WHERE hotel_id = ? AND room_id = ? AND occupancy_date BETWEEN ? AND ?",
            [hotelId, roomId, startDate, endDate]
        );

        console.log(`Found ${rows.length} rows.`);
        rows.forEach(row => {
            const dateStr = row.occupancy_date.toISOString().split('T')[0];
            console.log(`Date: ${dateStr} | RatePlan: ${row.rate_plan_code} | Rates JSON: ${JSON.stringify(row.occupancy_rates)}`);
        });

        await conn.end();
    } catch (e) {
        console.error('Script Error:', e);
    }
})();
