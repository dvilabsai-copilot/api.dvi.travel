const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const conn = await mysql.createConnection(
    process.env.DATABASE_URL ||
      'mysql://root:8UMmdX%2344PId%23tdJ@127.0.0.1:3306/dvi_main',
  );

  const [mapped] = await conn.query(
    "SELECT COUNT(*) c FROM dvi_hotel WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''",
  );

  const [inboundDistinct] = await conn.query(
    "SELECT COUNT(DISTINCT axisrooms_property_id) c FROM axisrooms_inbound_log WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''",
  );

  const [recentInbound] = await conn.query(
    "SELECT axisrooms_property_id, MAX(received_at) AS last_sync, COUNT(*) AS cnt FROM axisrooms_inbound_log WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != '' GROUP BY axisrooms_property_id ORDER BY last_sync DESC LIMIT 25",
  );

  const [mappedFromInbound] = await conn.query(
    "SELECT DISTINCT TRIM(l.axisrooms_property_id) AS inbound_property_id, h.hotel_id, h.hotel_name FROM axisrooms_inbound_log l LEFT JOIN dvi_hotel h ON TRIM(h.axisrooms_property_id) COLLATE utf8mb4_unicode_ci = TRIM(l.axisrooms_property_id) COLLATE utf8mb4_unicode_ci WHERE l.axisrooms_property_id IS NOT NULL AND l.axisrooms_property_id != '' ORDER BY inbound_property_id",
  );

  const [exactApiStyleCount] = await conn.query(
    "SELECT COUNT(*) c FROM dvi_hotel h WHERE EXISTS (SELECT 1 FROM axisrooms_inbound_log l WHERE l.axisrooms_property_id COLLATE utf8mb4_unicode_ci = h.axisrooms_property_id COLLATE utf8mb4_unicode_ci AND l.axisrooms_property_id IS NOT NULL AND l.axisrooms_property_id != '') AND (h.deleted = 0 OR h.deleted IS NULL)",
  );

  console.log('mapped_hotels_with_axisrooms_property_id =', mapped[0].c);
  console.log('distinct_properties_with_inbound_logs =', inboundDistinct[0].c);
  console.table(recentInbound);
  console.log('inbound_properties_mapped_to_hotels:');
  console.table(mappedFromInbound);
  console.log('exact_api_style_match_count =', exactApiStyleCount[0].c);

  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
