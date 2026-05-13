const mysql = require("mysql2/promise");
(async () => {
    try {
        const connection = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        const itineraryCode = 'DVI20260588';
        const day = 4;

        const [plans] = await connection.query("SELECT * FROM dvi_itinerary_plan WHERE itinerary_code = ?", [itineraryCode]);
        if (plans.length === 0) { console.log("Plan not found"); return; }
        const plan = plans[0];
        console.log(`Plan ID: ${plan.itinerary_plan_id}, Code: ${itineraryCode}`);

        const [routes] = await connection.query("SELECT * FROM dvi_itinerary_route WHERE itinerary_plan_id = ? AND day_number = ?", [plan.itinerary_plan_id, day]);
        if (routes.length === 0) { console.log(`Route for day ${day} not found`); return; }
        const route = routes[0];
        console.log(`Route ID: ${route.itinerary_route_id}, Source City: ${route.source_city_id}, Dest City: ${route.destination_city_id}`);

        const excludedIds = plan.excluded_hotspot_ids ? plan.excluded_hotspot_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id)) : [];
        const [usedHotspots] = await connection.query("SELECT DISTINCT hotspot_id FROM dvi_itinerary_route_hotspot_details WHERE itinerary_route_ID IN (SELECT itinerary_route_id FROM dvi_itinerary_route WHERE itinerary_plan_id = ?)", [plan.itinerary_plan_id]);
        const alreadyUsedIds = usedHotspots.map(h => h.hotspot_id);

        console.log("Excluded IDs:", excludedIds);
        console.log("Already Added IDs (across all days):", alreadyUsedIds);

        const [cityHotspots] = await connection.query(`
            SELECT hotspot_ID, hotspot_name, hotspot_priority, hotspot_location 
            FROM dvi_hotspot_place 
            WHERE city_ID IN (?, ?)
        `, [route.source_city_id, route.destination_city_id]);

        const filtered = cityHotspots.filter(h => !excludedIds.includes(h.hotspot_ID) && !alreadyUsedIds.includes(h.hotspot_ID));

        if (filtered.length > 0) {
            console.log("\n--- Eligible Hotspots (Sorted by Priority) ---");
            console.table(filtered.sort((a,b) => b.hotspot_priority - a.hotspot_priority));
        } else {
            const inCityCount = cityHotspots.length;
            const excludedCount = cityHotspots.filter(h => excludedIds.includes(h.hotspot_ID)).length;
            const usedCount = cityHotspots.filter(h => alreadyUsedIds.includes(h.hotspot_ID)).length;
            console.log("\nNo eligible hotspots found.");
            console.log(`Total hotspots in Source/Dest cities: ${inCityCount}`);
            console.log(`Filtered out by Exclusion: ${excludedCount}`);
            console.log(`Filtered out because already used: ${usedCount}`);
        }

        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
