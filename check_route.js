const mysql = require("mysql2/promise");
(async () => {
    try {
        const connection = await mysql.createConnection("mysql://dvi_user:myDvi123!@localhost:3306/dvi_main");
        const [routes] = await connection.query("SELECT * FROM dvi_itinerary_route WHERE itinerary_route_id = 4008");
        console.dir(routes, { depth: null });
        await connection.end();
    } catch (e) {
        console.error(e);
    }
})();
