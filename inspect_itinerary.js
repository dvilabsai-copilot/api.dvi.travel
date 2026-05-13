const mysql = require("mysql2/promise");
(async () => {
    try {
        const connection = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        const itineraryNo = 'DVI20260588';

        console.log(`\n--- Inspecting Itinerary: ${itineraryNo} ---`);
        const [plans] = await connection.query("SELECT id, itinerary_no, excluded_hotspot_ids FROM dvi_itinerary_plan WHERE itinerary_no = ?", [itineraryNo]);
        if (plans.length === 0) { console.log("Plan not found"); return; }
        const plan = plans[0];
        console.log(`Plan ID: ${plan.id}, Excluded Hotspots: ${plan.excluded_hotspot_ids}`);

        console.log(`\n--- Route Rows ---`);
        const [routes] = await connection.query(`
            SELECT id, day_number, from_place_name, to_place_name, date_of_travel 
            FROM dvi_itinerary_route 
            WHERE itinerary_plan_id = ? 
            ORDER BY day_number
        `, [plan.id]);
        routes.forEach(r => console.log(`Day ${r.day_number}: ID ${r.id} | ${r.from_place_name} -> ${r.to_place_name} | ${r.date_of_travel}`));

        const day4Route = routes.find(r => r.day_number === 4);
        if (day4Route) {
            console.log(`\n--- Day 4 (Route ID: ${day4Route.id}) Hotspot Details ---`);
            const [hotspots] = await connection.query(`
                SELECT h.item_type, h.hotspot_id, p.hotspot_name, h.hotspot_priority, h.hotspot_plan_own_way, h.deleted, h.status
                FROM dvi_itinerary_route_hotspot_details h
                LEFT JOIN dvi_hotspot_place p ON h.hotspot_id = p.hotspot_ID
                WHERE h.itinerary_route_ID = ?
            `, [day4Route.id]);
            console.table(hotspots);

            const activeHotspots = hotspots.filter(h => !h.deleted && h.status === 'active' && h.item_type !== 'manual');
            console.log(`\nActive/Eligible (Non-Manual) Hotspots in Route Detail: ${activeHotspots.length}`);
        }

        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
