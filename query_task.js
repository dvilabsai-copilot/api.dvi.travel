const mysql = require('mysql2/promise');

(async () => {
    try {
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        console.log('--- 1. Querying Plan for DVI20260589 ---');
        const [plans] = await conn.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260589'");
        if (plans.length === 0) {
            console.log('No plan found for quote DVI20260589');
        } else {
            const planId = plans[0].itinerary_plan_ID;
            console.log(`Plan ID: ${planId}`);

            console.log('\n--- 2. Listing Routes for Plan ---');
            const [routes] = await conn.query(
                "SELECT itinerary_route_ID, itinerary_day_no, itinerary_route_date, location_name FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_route_date",
                [planId]
            );
            console.table(routes);
        }

        console.log('\n--- 3. Checking Hotel 153 Status ---');
        const [hotels] = await conn.query("SELECT hotel_id, hotel_name, status FROM dvi_hotel_details WHERE hotel_id = 153");
        console.table(hotels);

        console.log('\n--- 4. Checking Occupancy Rate for CP_PLAN (Hotel 153, Room 189) ---');
        const [rates] = await conn.query(
            "SELECT id, occupancy_rates, received_at FROM dvi_hotel_occupancy_rate WHERE hotel_id = 153 AND room_id = 189 AND rate_plan_code = 'CP_PLAN'"
        );
        
        if (rates.length > 0) {
            rates.forEach(r => {
                console.log(`ID: ${r.id}`);
                console.log(`Received At: ${r.received_at}`);
                try {
                    console.log('Occupancy Rates JSON:', JSON.stringify(JSON.parse(r.occupancy_rates), null, 2));
                } catch(e) {
                    console.log('Occupancy Rates (raw):', r.occupancy_rates);
                }
                console.log('-----------------------------------');
            });
        } else {
            console.log('No occupancy rates found.');
        }

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
