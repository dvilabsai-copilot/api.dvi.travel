const mysql = require("mysql2/promise");
(async () => {
    try {
        const connection = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        
        console.log("--- 1. Plan ID for DVI20260588 ---");
        const [plans] = await connection.query("SELECT itinerary_plan_id FROM dvi_itinerary_plan WHERE itinerary_code = 'DVI20260588'");
        console.dir(plans);

        if (plans.length > 0) {
            const planId = plans[0].itinerary_plan_id;
            console.log(`\n--- 2. All routes for Plan ID: ${planId} ---`);
            const [routes] = await connection.query("SELECT itinerary_route_id, day_number, source_city_id, destination_city_id FROM dvi_itinerary_route WHERE itinerary_plan_id = ?", [planId]);
            console.table(routes);
        }

        console.log("\n--- 3. Details for Route 4008 ---");
        const [route4008] = await connection.query("SELECT * FROM dvi_itinerary_route WHERE itinerary_route_id = 4008");
        console.dir(route4008);

        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
