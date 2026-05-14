const mysql = require('mysql2/promise');

(async () => {
    try {
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        const quoteId = 'DVI20260589';
        console.log(`--- Querying Plan for ${quoteId} ---`);
        const [plans] = await conn.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = ?", [quoteId]);
        
        if (plans.length === 0) {
            console.log('No plan found.');
            await conn.end();
            return;
        }
        const planId = plans[0].itinerary_plan_ID;
        console.log(`Plan ID: ${planId}`);

        console.log('\n--- 2. Hotels in Plan ---');
        const [planHotels] = await conn.query(
            "SELECT hotel_id, room_id, itinerary_route_id, hotel_name FROM dvi_itinerary_plan_hotel_details WHERE itinerary_plan_id = ? AND status = 1 AND deleted = 0",
            [planId]
        );
        console.table(planHotels);

        if (planHotels.length > 0) {
            const hotelIds = [...new Set(planHotels.map(h => h.hotel_id))];
            const roomIds = [...new Set(planHotels.map(h => h.room_id))];

            console.log('\n--- 3. Rate Plans for these Hotels/Rooms ---');
            const [ratePlans] = await conn.query(
                "SELECT hotel_id, room_id, rate_plan_code, meal_plan_name, meal_plan_description FROM dvi_hotel_room_rate_plan WHERE hotel_id IN (?) AND room_id IN (?)",
                [hotelIds, roomIds]
            );
            console.table(ratePlans);

            console.log('\n--- 4. Occupancy Rates for these Hotels/Rooms ---');
            const [occupancy] = await conn.query(
                "SELECT hotel_id, room_id, rate_plan_code, single_occupancy_rate, double_occupancy_rate, triple_occupancy_rate FROM dvi_hotel_occupancy_rate WHERE hotel_id IN (?) AND room_id IN (?)",
                [hotelIds, roomIds]
            );
            console.table(occupancy);
        }

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
