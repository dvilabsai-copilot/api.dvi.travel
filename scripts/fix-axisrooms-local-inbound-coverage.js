require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const report = {
    trimmedHotelPropertyIds: 0,
    trimmedInboundPropertyIds: 0,
    alignedFromInboundCanonical: 0,
    backfilledInboundRows: 0,
  };

  await conn.query('START TRANSACTION');
  try {
    // 1) Normalize trailing/leading spaces in local mappings and inbound logs.
    const [trimHotels] = await conn.query(
      "UPDATE dvi_hotel SET axisrooms_property_id = TRIM(axisrooms_property_id) WHERE axisrooms_property_id IS NOT NULL AND CHAR_LENGTH(axisrooms_property_id) != CHAR_LENGTH(TRIM(axisrooms_property_id))",
    );
    report.trimmedHotelPropertyIds = Number(trimHotels.affectedRows || 0);

    const [trimInbound] = await conn.query(
      "UPDATE axisrooms_inbound_log SET axisrooms_property_id = TRIM(axisrooms_property_id) WHERE axisrooms_property_id IS NOT NULL AND CHAR_LENGTH(axisrooms_property_id) != CHAR_LENGTH(TRIM(axisrooms_property_id))",
    );
    report.trimmedInboundPropertyIds = Number(trimInbound.affectedRows || 0);

    // 2) If inbound already contains canonical AX_DVI_HOTEL_{hotel_id}, align hotel mapping to it.
    const [alignRows] = await conn.query(
      `UPDATE dvi_hotel h
       JOIN (
         SELECT DISTINCT axisrooms_property_id
         FROM axisrooms_inbound_log
         WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''
       ) l
         ON l.axisrooms_property_id = CONCAT('AX_DVI_HOTEL_', h.hotel_id)
       SET h.axisrooms_property_id = CONCAT('AX_DVI_HOTEL_', h.hotel_id)
       WHERE h.axisrooms_property_id IS NULL
          OR h.axisrooms_property_id = ''
          OR h.axisrooms_property_id <> CONCAT('AX_DVI_HOTEL_', h.hotel_id)`,
    );
    report.alignedFromInboundCanonical = Number(alignRows.affectedRows || 0);

    // 3) Backfill inbound logs for synced properties that have data in AxisRooms tables but no inbound rows yet.
    const [missingProps] = await conn.query(
      `SELECT DISTINCT p.axisrooms_property_id
       FROM (
         SELECT axisrooms_property_id FROM axisrooms_inventory WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''
         UNION
         SELECT axisrooms_property_id FROM axisrooms_restriction WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''
         UNION
         SELECT axisrooms_property_id FROM axisrooms_room WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''
       ) p
       LEFT JOIN axisrooms_inbound_log l ON l.axisrooms_property_id = p.axisrooms_property_id
       WHERE l.axisrooms_property_id IS NULL`,
    );

    for (const row of missingProps) {
      await conn.query(
        `INSERT INTO axisrooms_inbound_log (type, axisrooms_property_id, room_id, rateplan_id, payload, received_at)
         VALUES ('inventoryUpdate', ?, NULL, NULL, ?, NOW())`,
        [String(row.axisrooms_property_id), JSON.stringify({ synthetic_backfill: true })],
      );
      report.backfilledInboundRows += 1;
    }

    await conn.query('COMMIT');

    const [summary] = await conn.query(
      `SELECT
         (SELECT COUNT(*) FROM dvi_hotel WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != '') AS mapped_hotels,
         (SELECT COUNT(DISTINCT axisrooms_property_id) FROM axisrooms_inbound_log WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != '') AS inbound_properties`,
    );

    console.log('DATA FIX REPORT');
    console.table([report]);
    console.log('POST-FIX SUMMARY');
    console.table(summary);

    const [top] = await conn.query(
      `SELECT axisrooms_property_id, MAX(received_at) AS last_sync, COUNT(*) AS cnt
       FROM axisrooms_inbound_log
       WHERE axisrooms_property_id IS NOT NULL AND axisrooms_property_id != ''
       GROUP BY axisrooms_property_id
       ORDER BY last_sync DESC
       LIMIT 20`,
    );
    console.table(top);
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
