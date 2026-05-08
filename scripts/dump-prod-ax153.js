/**
 * dump-prod-ax153.js
 * Dumps all AxisRooms-related production data for AX_DVI_HOTEL_153.
 * Run: node scripts/dump-prod-ax153.js > /tmp/prod_ax153_dump.json
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  try {
    const [[hotelRow]] = await conn.query(
      "SELECT * FROM dvi_hotel WHERE axisrooms_property_id = 'AX_DVI_HOTEL_153' LIMIT 1"
    );
    if (!hotelRow) {
      process.stdout.write(JSON.stringify({ error: 'no hotel found' }) + '\n');
      return;
    }
    const id = hotelRow.hotel_id;

    // Serialize dates as ISO strings for clean JSON
    const serial = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => v instanceof Date ? v.toISOString() : v));
    // Helper: query table if it exists, otherwise return []
    async function safeQuery(sql, params) {
      try { const [r] = await conn.query(sql, params); return serial(r); } catch (e) { return []; }
    }

    const [rooms]  = await conn.query('SELECT * FROM dvi_hotel_rooms WHERE hotel_id=? AND deleted=0 ORDER BY room_ID', [id]);
    const [rp]     = await conn.query('SELECT * FROM dvi_hotel_room_rate_plan WHERE hotel_id=? AND deleted=0 ORDER BY room_id, rateplan_id', [id]);
    const [occ]    = await conn.query('SELECT * FROM dvi_hotel_occupancy_rate WHERE hotel_id=? ORDER BY room_id, rateplan_id, start_date', [id]);
    const [avail]  = await conn.query('SELECT * FROM dvi_hotel_room_availability WHERE hotel_id=? ORDER BY room_id, start_date', [id]);
    const arroom = await safeQuery("SELECT * FROM axisrooms_room WHERE axisrooms_property_id='AX_DVI_HOTEL_153' ORDER BY room_id");
    const arrp   = await safeQuery("SELECT * FROM axisrooms_rateplan WHERE axisrooms_property_id='AX_DVI_HOTEL_153' ORDER BY room_id, rateplan_id");
    const arinv  = await safeQuery("SELECT * FROM axisrooms_inventory WHERE axisrooms_property_id='AX_DVI_HOTEL_153' ORDER BY room_id, start_date");
    const arrate = await safeQuery("SELECT * FROM axisrooms_rate WHERE axisrooms_property_id='AX_DVI_HOTEL_153' ORDER BY room_id, rateplan_id, start_date");
    const arrest = await safeQuery("SELECT * FROM axisrooms_restriction WHERE axisrooms_property_id='AX_DVI_HOTEL_153' ORDER BY room_id, start_date");

    process.stdout.write(JSON.stringify({
      hotel: serial([hotelRow])[0],
      rooms: serial(rooms),
      rp: serial(rp),
      occ: serial(occ),
      avail: serial(avail),
      ax_rooms: arroom,
      ax_rp: arrp,
      ax_inv: arinv,
      ax_rate: arrate,
      ax_rest: arrest,
    }) + '\n');
  } finally {
    await conn.end();
  }
})().catch(e => {
  process.stderr.write('ERR: ' + (e.message || String(e)) + '\n');
  process.exit(1);
});
