const mysql = require("mysql2/promise");
(async () => {
    try {
        const connection = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        const routeId = 4008;
        const [hotspots] = await connection.query(`
            SELECT h.itinerary_route_hotspot_id, h.itinerary_plan_id, h.itinerary_route_id, 
                   h.hotspot_id, h.arrival_time, h.departure_time, h.route_hotspot_order, 
                   p.hotspot_name
            FROM dvi_itinerary_route_hotspot_details h 
            LEFT JOIN dvi_hotspot_place p ON h.hotspot_id = p.hotspot_ID 
            WHERE h.itinerary_route_ID = ? AND h.deleted = 0
            ORDER BY h.route_hotspot_order ASC
        `, [routeId]);
        
        console.log("Hotspots for Day 4:");
        console.table(hotspots);
        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
