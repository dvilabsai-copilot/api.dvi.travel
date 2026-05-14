const mysql = require("mysql2/promise");
const fs = require("fs");

(async () => {
    try {
        const conn = await mysql.createConnection({host:"localhost", user:"dvi_user", password:"myDvi123!", database:"dvi_main"});
        const planId = 380;
        const routeId = 4033;

        // 1 & 2. Route & Location Metadata
        const [routes] = await conn.query("SELECT * FROM dvi_itinerary_route_details WHERE itinerary_route_ID = ?", [routeId]);
        const route = routes[0];
        const [locs] = await conn.query("SELECT * FROM dvi_stored_locations WHERE location_ID = ?", [route.location_id]);
        const loc = locs[0];

        console.log(`\n--- Metadata ---`);
        console.log(`Route ${routeId}: ${route.itinerary_route_date} | ${route.route_start_time}-${route.route_end_time} | ${route.no_of_km}km`);
        console.log(`Location: ${loc.source_location} -> ${loc.destination_location} (Cities: ${loc.source_city_id}, ${loc.destination_city_id})`);

        // 4. Excluded
        const [plans] = await conn.query("SELECT excluded_hotspot_ids FROM dvi_itinerary_plan_details WHERE itinerary_plan_ID = ?", [planId]);
        const excludedStr = plans[0]?.excluded_hotspot_ids || "";
        const excluded = excludedStr ? excludedStr.split(",").map(Number) : [];

        // 5. Used on other routes
        const [usedRows] = await conn.query("SELECT DISTINCT hotspot_ID FROM dvi_itinerary_route_hotspot_details WHERE itinerary_plan_ID = ? AND itinerary_route_ID != ? AND deleted = 0 AND status = 1 AND item_type = 4", [planId, routeId]);
        const usedOtherMap = new Set(usedRows.map(r => r.hotspot_ID));

        // 3. Pool
        const [pool] = await conn.query("SELECT hotspot_ID, hotspot_name, hotspot_priority FROM dvi_hotspot_place WHERE city_ID IN (?, ?) AND deleted = 0 AND status = 1", [loc.source_city_id, loc.destination_city_id]);
        
        const excludedPool = pool.filter(h => excluded.includes(h.hotspot_ID));
        const usedElsewherePool = pool.filter(h => usedOtherMap.has(h.hotspot_ID));
        const eligible = pool.filter(h => !excluded.includes(h.hotspot_ID) && !usedOtherMap.has(h.hotspot_ID));

        console.log(`\n--- Stats ---`);
        console.log(`Total City Hotspots: ${pool.length}`);
        console.log(`Excluded: ${excludedPool.length}`);
        console.log(`Used on other routes: ${usedElsewherePool.length}`);
        console.log(`Eligible: ${eligible.length}`);

        // 7. Scheduled
        const [scheduled] = await conn.query("SELECT p.hotspot_name, h.hotspot_ID FROM dvi_itinerary_route_hotspot_details h JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID WHERE h.itinerary_route_ID = ? AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4 ORDER BY h.route_hotspot_order", [routeId]);
        console.log(`\n--- Scheduled (${scheduled.length}) ---`);
        scheduled.forEach((s, i) => console.log(`  ${i+1}. ${s.hotspot_name} (${s.hotspot_ID})`));

        await conn.end();

        // 8 & 9. Logs
        const tracePath = "tmp/php-parity-trace.log";
        console.log(`\n--- Logs (tmp/php-parity-trace.log) ---`);
        if (fs.existsSync(tracePath)) {
            const lines = fs.readFileSync(tracePath, "utf8").split("\n").slice(-400);
            lines.filter(l => /4033|PHP_GATE_ROUTE_END|HOTSPOT_CANDIDATE_EVALUATION|SCHEDULER_CYCLE_SUMMARY|SCHEDULER_EXIT_NO_STRICT_PENDING/.test(l))
                 .slice(-20).forEach(l => console.log(l));
        }

        const backendLog = "C:/wamp64/www/dvi_fullstack/backend-live-4006.txt";
        console.log(`\n--- Logs (backend-live-4006.txt) ---`);
        if (fs.existsSync(backendLog)) {
             const lines = fs.readFileSync(backendLog, "utf8").split("\n").slice(-400);
             lines.filter(l => /RebuildPersist|RouteRebuild/.test(l))
                  .slice(-10).forEach(l => console.log(l));
        }

    } catch (e) { console.error(e); }
})();
