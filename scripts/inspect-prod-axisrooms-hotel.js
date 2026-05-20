require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const propertyId = process.argv[2];
  if (!propertyId) throw new Error('Pass property id');
  const conn = await mysql.createConnection(process.env.PROD_DATABASE_URL);

  const [logs] = await conn.query(
    `SELECT type, COUNT(*) AS c, MAX(received_at) AS last_sync
     FROM axisrooms_inbound_log
     WHERE axisrooms_property_id = ?
     GROUP BY type
     ORDER BY last_sync DESC`,
    [propertyId],
  );

  const [inventory] = await conn.query(
    `SELECT COUNT(*) AS c, MAX(received_at) AS last_sync
     FROM axisrooms_inventory
     WHERE axisrooms_property_id = ?`,
    [propertyId],
  );

  const [restriction] = await conn.query(
    `SELECT COUNT(*) AS c, MAX(received_at) AS last_sync
     FROM axisrooms_restriction
     WHERE axisrooms_property_id = ?`,
    [propertyId],
  );

  const [hotel] = await conn.query(
    `SELECT hotel_id, hotel_name FROM dvi_hotel WHERE axisrooms_property_id = ? LIMIT 1`,
    [propertyId],
  );

  const hotelId = hotel[0]?.hotel_id || 0;
  const [rates] = await conn.query(
    `SELECT COUNT(*) AS c, MAX(received_at) AS last_sync
     FROM dvi_hotel_occupancy_rate
     WHERE hotel_id = ? AND source = 'axisrooms'`,
    [hotelId],
  );

  console.log('hotel');
  console.table(hotel);
  console.log('logs');
  console.table(logs);
  console.log('inventory');
  console.table(inventory);
  console.log('restriction');
  console.table(restriction);
  console.log('rates');
  console.table(rates);

  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
