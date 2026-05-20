const mysql = require('mysql2/promise');
const axios = require('axios');
const fs = require('fs');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');

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

        const quoteId = 'DVI20260589';

        // 1. & 2. Query database for plan hotel details
        console.log(`--- Database Records for ${quoteId} ---`);
        const [planRows] = await conn.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = ?", [quoteId]);
        if (planRows.length === 0) {
            console.log("No plan found.");
            await conn.end();
            return;
        }
        const planId = planRows[0].itinerary_plan_ID;

        const [dbHotels] = await conn.query(`
            SELECT hd.itinerary_plan_hotel_ID, hd.hotel_id, h.hotel_name, hd.rate_plan_code, hd.meal_plan_name
            FROM dvi_itinerary_plan_hotel_details hd
            LEFT JOIN dvi_hotel_details h ON hd.hotel_id = h.hotel_id
            WHERE hd.itinerary_plan_ID = ? AND hd.deleted = 0
        `, [planId]);
        console.table(dbHotels);

        // 3. Call API
        console.log(`\n--- API Response for ${quoteId} ---`);
        const jwtSecret = process.env.JWT_SECRET || 'your-default-secret';
        const token = jwt.sign({ sub: '1', email: 'admin@dvi.co.in', role: 1 }, jwtSecret);
        
        try {
            const response = await axios.get(`http://127.0.0.1:4006/api/v1/itineraries/hotel_details/${quoteId}`, {
                headers: { Authorization: 'Bearer ' + token }
            });
            
            const apiData = response.data.data || response.data;
            if (Array.isArray(apiData)) {
                const apiTable = apiData.map(h => ({
                    hotelId: h.hotelId,
                    hotelName: h.hotelName,
                    mealPlan: h.mealPlan,
                    ratePlanCode: h.ratePlanCode
                }));
                console.table(apiTable);

                // 4. Comparison
                console.log("\n--- Comparison ---");
                dbHotels.forEach(dbH => {
                    const match = apiData.find(apiH => apiH.hotelId == dbH.hotel_id);
                    if (match) {
                        const mismatch = (dbH.meal_plan_name !== match.mealPlan) || (dbH.rate_plan_code !== match.ratePlanCode);
                        console.log(`Hotel: ${dbH.hotel_name}`);
                        console.log(`  DB: ${dbH.rate_plan_code} / ${dbH.meal_plan_name}`);
                        console.log(`  API: ${match.ratePlanCode} / ${match.mealPlan}`);
                        console.log(`  Match: ${mismatch ? '❌ MISMATCH' : '✅ OK'}`);
                    } else {
                        console.log(`Hotel: ${dbH.hotel_name} - Not found in API response.`);
                    }
                });
            } else {
                console.log("Unexpected API response format.");
            }
        } catch (apiErr) {
            console.error("API Error:", apiErr.message);
        }

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
