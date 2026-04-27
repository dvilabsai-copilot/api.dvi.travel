require('dotenv').config();
const mysql = require('mysql2/promise');

async function main() {
  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  if (!m) throw new Error('Invalid DATABASE_URL');

  const conn = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const [existsRows] = await conn.query(
    `SELECT COUNT(1) AS cnt
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'dvi_global_settings'
       AND COLUMN_NAME = 'meal_plan_search_enabled'`
  );

  const exists = Number((existsRows[0] || {}).cnt || 0) > 0;
  if (!exists) {
    await conn.query(
      `ALTER TABLE dvi_global_settings
       ADD COLUMN meal_plan_search_enabled TINYINT(1) NOT NULL DEFAULT 1
       AFTER hotel_terms_condition`
    );
    console.log('Added column: meal_plan_search_enabled');
  } else {
    console.log('Column already exists: meal_plan_search_enabled');
  }

  await conn.query(
    `UPDATE dvi_global_settings
     SET meal_plan_search_enabled = 1
     WHERE meal_plan_search_enabled IS NULL`
  );

  await conn.query(
    `UPDATE dvi_global_settings
     SET meal_plan_search_enabled = 0
     WHERE deleted = 0`
  );

  const [rows] = await conn.query(
    `SELECT global_settings_ID, meal_plan_search_enabled
     FROM dvi_global_settings
     WHERE deleted = 0
     ORDER BY global_settings_ID DESC
     LIMIT 1`
  );

  console.log('Latest global setting row:', rows[0] || null);
  await conn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
