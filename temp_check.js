const mysql = require('mysql2/promise');
(async () => {
    try {
        const conn = await mysql.createConnection({host:'localhost',user:'dvi_user',password:'myDvi123!',database:'dvi_main'});
        const [rows] = await conn.query('SELECT p.hotspot_name FROM dvi_itinerary_route_hotspot_details h JOIN dvi_hotspot_place p ON h.hotspot_ID = p.hotspot_ID WHERE h.itinerary_route_ID = 4033 AND h.deleted = 0 AND h.status = 1 AND h.item_type = 4 ORDER BY h.route_hotspot_order');
        console.log('Resulting Hotspots (' + rows.length + '):');
        rows.forEach((r, i) => console.log('  ' + (i+1) + '. ' + r.hotspot_name));
        await conn.end();
    } catch (e) { console.error(e); }
})();
