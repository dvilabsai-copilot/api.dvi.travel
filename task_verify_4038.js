const mysql = require("mysql2/promise");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const dotenv = require("dotenv");

if (fs.existsSync(".env")) {
    const envConfig = dotenv.parse(fs.readFileSync(".env"));
    for (const k in envConfig) { process.env[k] = envConfig[k]; }
}

(async () => {
    try {
        const planId = 380;
        const routeId = 4038;
        const jwtSecret = process.env.JWT_SECRET || "your-default-secret";
        const token = jwt.sign({ sub: "1", email: "admin@dvi.co.in", role: 1 }, jwtSecret);

        console.log(`\n--- 1. Calling Rebuild API (Plan: ${planId}, Route: ${routeId}) ---`);
        try {
            const res = await axios.post(`http://127.0.0.1:4006/api/v1/itineraries/${planId}/route/${routeId}/rebuild`, {}, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log(`Status: ${res.status}`);
            console.log("Response:", JSON.stringify({
                success: res.data.success,
                routeId: res.data.routeId,
                rebuildSummary: res.data.rebuildSummary,
                routeRejectionSummary: res.data.routeRejectionSummaryByRoute?.[routeId]
            }, null, 2));
        } catch (e) {
            console.error(`API Error: ${e.message}`, e.response ? e.response.data : "");
        }

        console.log(`\n--- 2. MySQL Status for Route ${routeId} ---`);
        const conn = await mysql.createConnection({host:"localhost", user:"dvi_user", password:"myDvi123!", database:"dvi_main"});
        
        const [rows] = await conn.query(
            "SELECT h.hotspot_ID, p.hotspot_name, h.route_hotspot_order " +
            "FROM dvi_itinerary_route_hotspot_details h " +
            "JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID " +
            "WHERE h.itinerary_route_ID=? AND h.deleted=0 AND h.status=1 AND h.item_type=4 " +
            "ORDER BY h.route_hotspot_order", 
            [routeId]
        );
        
        console.log(`Total active hotspots: ${rows.length}`);
        rows.forEach(r => console.log(` - [${r.route_hotspot_order}] ${r.hotspot_name} (${r.hotspot_ID})`));

        await conn.end();
    } catch (e) { console.error(e); }
})();
