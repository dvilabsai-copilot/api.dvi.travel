const mysql = require("mysql2/promise");
(async () => {
    try {
        const conn = await mysql.createConnection({host: "localhost", user: "dvi_user", password: "myDvi123!", database: "dvi_main"});
        
        const [planCols] = await conn.query("DESCRIBE dvi_itinerary_plan_details");
        const cols = planCols.map(c => c.Field);
        let planIdQuery = "";
        if (cols.includes("itinerary_code")) planIdQuery = "SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_code = ?";
        else if (cols.includes("itinerary_quote_ID")) planIdQuery = "SELECT itinerary_plan_ID FROM dvi_itinerary_plan_details WHERE itinerary_quote_ID = ?";
        
        let [planRows] = await conn.query(planIdQuery, ["DVI20260580"]);
        if (planRows.length === 0) {
            [planRows] = await conn.query("SELECT id as itinerary_plan_ID FROM dvi_itinerary_plan WHERE itinerary_no = ?", ["DVI20260580"]);
        }
        
        if (planRows.length === 0) { console.log("Plan not found"); await conn.end(); return; }
        const planId = planRows[0].itinerary_plan_ID;
        console.log(`Plan ID: ${planId}`);

        const [routes] = await conn.query("SELECT itinerary_route_ID, itinerary_day_no, location_name FROM dvi_itinerary_route_details WHERE itinerary_plan_ID = ? ORDER BY itinerary_day_no", [planId]);
        console.log(`Routes found: ${routes.length}`);

        const [items] = await conn.query(`
            SELECT h.itinerary_route_ID, h.route_hotspot_order, h.hotspot_order, h.item_type, h.hotspot_ID, 
                   h.hotspot_start_time, h.hotspot_end_time, h.hotspot_traveling_time, h.allow_break_hours, p.hotspot_name
            FROM dvi_itinerary_route_hotspot_details h
            LEFT JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_id
            WHERE h.itinerary_plan_ID = ? AND h.deleted = 0
            ORDER BY h.itinerary_route_ID, h.route_hotspot_order, h.hotspot_order
        `, [planId]);

        console.log("\n--- Break / Large Gap Inspection ---");
        items.forEach((item, index) => {
            const isBreak = item.item_type === 3 || (item.hotspot_name && item.hotspot_name.toLowerCase().includes("break"));
            
            // Check for ~5h55m gap or explicit break
            // 5h55m = 355 minutes.
            const start = item.hotspot_start_time || "";
            const end = item.hotspot_end_time || "";
            
            if (isBreak || item.allow_break_hours > 0) {
                 console.log(`Match Found: Route ${item.itinerary_route_ID} | Order ${item.route_hotspot_order} | Type ${item.item_type}`);
                 console.log(`  Name: ${item.hotspot_name || 'N/A'} | Time: ${start} - ${end} | Travel: ${item.hotspot_traveling_time} | AllowBreak: ${item.allow_break_hours}`);
                 
                 console.log("  Surrounding Context:");
                 if (index > 0) console.log(`    Prev: ${items[index-1].hotspot_name || 'Type '+items[index-1].item_type} (${items[index-1].hotspot_start_time} - ${items[index-1].hotspot_end_time})`);
                 if (index < items.length - 1) console.log(`    Next: ${items[index+1].hotspot_name || 'Type '+items[index+1].item_type} (${items[index+1].hotspot_start_time} - ${items[index+1].hotspot_end_time})`);
                 console.log("");
            }
        });

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
