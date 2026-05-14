const mysql = require('mysql2/promise');

(async () => {
    try {
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        console.log('--- 1. Plan for DVI20260589 ---');
        const [plans] = await conn.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260589'");
        console.table(plans);
        const planId = plans[0]?.itinerary_plan_ID;

        if (planId) {
            console.log(`\n--- 2. First 5 Routes for Plan ${planId} ---`);
            const [routes] = await conn.query(
                "SELECT itinerary_route_ID, itinerary_route_date, location_name FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? LIMIT 5",
                [planId]
            );
            console.table(routes);
        }

        console.log('\n--- 3. Hotel 153 Details ---');
        const [hotels] = await conn.query("SELECT hotel_id, hotel_name FROM dvi_hotel_details WHERE hotel_id = 153");
        console.table(hotels);

        console.log('\n--- 4. Occupancy Rates for Hotel 153, Room 189, CP_PLAN ---');
        const [rates] = await conn.query(
            "SELECT occupancy_rates FROM dvi_hotel_occupancy_rate WHERE hotel_id = 153 AND room_id = 189 AND rate_plan_code = 'CP_PLAN' ORDER BY received_at DESC LIMIT 1"
        );
        if (rates.length > 0) {
            console.log('Occupancy Rates JSON:');
            console.log(JSON.stringify(JSON.parse(rates[0].occupancy_rates), null, 2));
        } else {
            console.log('No occupancy rates found.');
        }

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
