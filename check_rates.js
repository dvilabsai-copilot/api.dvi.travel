const mysql = require('mysql2/promise');
(async () => {
    try {
        const conn = await mysql.createConnection({
            host: 'localhost',
            user: 'dvi_user',
            password: 'myDvi123!',
            database: 'dvi_main'
        });
        
        const hotel_id = 153;
        const room_id = 189;
        
        console.log(`--- Rates for Hotel ${hotel_id}, Room ${room_id} ---`);
        const [rows] = await conn.query(
            `SELECT start_date, end_date, rateplan_id, occupancy_rates 
             FROM dvi_hotel_room_rate_details 
             WHERE hotel_id = ? AND room_id = ? 
             AND end_date >= '2026-05-17' AND start_date <= '2026-05-21'
             ORDER BY start_date ASC`,
            [hotel_id, room_id]
        );
        
        console.log(`Total rows found: ${rows.length}`);
        
        rows.forEach(r => {
            const hasData = r.occupancy_rates && r.occupancy_rates !== '{}' && r.occupancy_rates !== '[]';
            console.log(`[${r.start_date} to ${r.end_date}] RP: ${r.rateplan_id} | Valid: ${hasData} | Rates: ${r.occupancy_rates}`);
        });

        await conn.end();
    } catch (e) {
        console.error(e);
    }
})();
