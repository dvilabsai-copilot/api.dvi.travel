const mysql = require('mysql2/promise');
(async () => {
    try {
        const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');
        
        console.log('--- 1. Searching for ID 41018 ---');
        const [planDetails] = await conn.query('SELECT itinerary_plan_ID, itinerary_code FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = 41018');
        const [routeDetails] = await conn.query('SELECT itinerary_route_ID, itinerary_plan_ID, no_of_days FROM dvi_itinerary_route_details WHERE itinerary_route_ID = 41018');
        const [planLegacy] = await conn.query('SELECT id, itinerary_no FROM dvi_itinerary_plan WHERE id = 41018');
        const [routeLegacy] = await conn.query('SELECT id, itinerary_plan_id, day_number FROM dvi_itinerary_route WHERE id = 41018');

        console.log('dvi_itinerary_plan_details (ID 41018):', planDetails);
        console.log('dvi_itinerary_route_details (ID 41018):', routeDetails);
        if (routeDetails.length > 0) {
            const pid = routeDetails[0].itinerary_plan_ID;
            console.log(`\n--- Routes for Plan ID ${pid} (from route 41018) ---`);
            const [routes] = await conn.query('SELECT no_of_days, location_name, next_visiting_location FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY no_of_days', [pid]);
            console.table(routes);
        }

        console.log('\n--- 2. Checking Plan 372 Routes ---');
        const [routes372] = await conn.query('SELECT no_of_days, location_name, next_visiting_location FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = 372 ORDER BY no_of_days');
        console.table(routes372);

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
