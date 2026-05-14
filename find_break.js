const mysql = require("mysql2/promise");
(async () => {
    try {
        const conn = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        
        // 1. Find planId
        let [plans] = await conn.query("SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = 'DVI20260580' OR itinerary_code = 'DVI20260580'");
        if (plans.length === 0) [plans] = await conn.query("SELECT id as itinerary_plan_ID FROM dvi_itinerary_plan WHERE itinerary_no = 'DVI20260580'");
        if (plans.length === 0) { console.log("Plan not found"); await conn.end(); return; }
        const planId = plans[0].itinerary_plan_ID;
        console.log(`Plan ID: ${planId}`);

        // 2. List routes
        const [routes] = await conn.query("SELECT itinerary_route_ID, itinerary_day_no FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_day_no", [planId]);
        console.log("Routes:", routes.map(r => `Day ${r.itinerary_day_no}: ${r.itinerary_route_ID}`).join(", "));

        // 3 & 4 & 5. Query hotspots including breaks
        const [rows] = await conn.query(`
            SELECT h.itinerary_route_ID, h.route_hotspot_order, h.hotspot_ID, h.item_type, 
                   h.hotspot_start_time, h.hotspot_end_time, h.hotspot_traveling_time, h.allow_break_hours,
                   p.hotspot_name
            FROM dvi_itinerary_route_hotspot_details h
            LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID
            WHERE h.itinerary_plan_ID = ? AND h.deleted = 0 AND h.status = 1
            ORDER BY h.itinerary_route_ID, h.route_hotspot_order
        `, [planId]);

        rows.forEach((row, i) => {
            if (row.allow_break_hours === 1) {
                const start = new Date("1970-01-01 " + row.hotspot_start_time);
                const end = new Date("1970-01-01 " + row.hotspot_end_time);
                const diffMin = (end - start) / 60000;
                
                // Focusing on the 5h 55m (approx 355 min) break
                if (diffMin > 300 && diffMin < 400) {
                    console.log(`\n--- Found target break on Route ${row.itinerary_route_ID} ---`);
                    for (let j = Math.max(0, i - 2); j <= Math.min(rows.length - 1, i + 2); j++) {
                        const r = rows[j];
                        const name = r.item_type === 1 ? "START" : r.item_type === 2 ? "END" : r.hotspot_name || (r.allow_break_hours ? "BREAK" : "Unknown");
                        console.log(`${r.itinerary_route_ID} | Ord ${r.route_hotspot_order} | Type ${r.item_type} | ${r.hotspot_start_time}-${r.hotspot_end_time} | Travel: ${r.hotspot_traveling_time} | Break: ${r.allow_break_hours} | Name: ${name}`);
                    }
                }
            }
        });

        await conn.end();
    } catch (e) { console.error(e); }
})();
