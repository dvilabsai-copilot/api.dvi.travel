const mysql = require('mysql2/promise');
(async () => {
    try {
        const connection = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });

        const tables = ['dvi_hotel', 'dvi_hotel_room_rate_plan', 'dvi_hotel_room_availability', 'dvi_hotel_occupancy_rate'];
        
        for (const table of tables) {
            console.log(`\n--- Table: ${table} ---`);
            const [cols] = await connection.query(`DESCRIBE ${table}`);
            const statusCol = cols.find(c => c.Field === 'status');
            console.log(`Status Column Type: ${statusCol ? statusCol.Type : 'NOT FOUND'}`);

            if (statusCol) {
                const [s1] = await connection.query(`SELECT COUNT(*) as count FROM ${table} WHERE status = 1`);
                const [sChar1] = await connection.query(`SELECT COUNT(*) as count FROM ${table} WHERE status = '1'`);
                const [sActive] = await connection.query(`SELECT COUNT(*) as count FROM ${table} WHERE status = 'active'`);
                const [total] = await connection.query(`SELECT COUNT(*) as count FROM ${table}`);
                
                console.log(`status = 1: ${s1[0].count}`);
                console.log(`status = '1': ${sChar1[0].count}`);
                console.log(`status = 'active': ${sActive[0].count}`);
                console.log(`Total rows: ${total[0].count}`);
            }
        }

        console.log(`\n--- Specific to DVI20260589 Hotels ---`);
        // Get plan then get hotels for that plan
        const [plans] = await connection.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260589'");
        if (plans.length > 0) {
            const planId = plans[0].itinerary_plan_ID;
            const [routes] = await connection.query("SELECT DISTINCT hotel_id FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ?", [planId]);
            const hotelIds = routes.map(r => r.hotel_id).filter(id => id);
            
            if (hotelIds.length > 0) {
                console.log(`Hotels in DVI20260589: ${hotelIds.join(',')}`);
                const [hStatus] = await connection.query(`SELECT hotel_id, status FROM dvi_hotel WHERE hotel_id IN (${hotelIds.join(',')})`);
                console.table(hStatus);
                
                const [rpStatus] = await connection.query(`SELECT hotel_id, rate_plan_code, status FROM dvi_hotel_room_rate_plan WHERE hotel_id IN (${hotelIds.join(',')})`);
                console.log("Rate Plan Statuses:");
                console.table(rpStatus);
            }
        }

        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
