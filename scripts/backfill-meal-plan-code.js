// Backfill meal_plan_code for existing rows based on meal boolean flags
// Run: node scripts/backfill-meal-plan-code.js
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

async function run() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL not set in .env');

  // parse mysql://user:pass@host:port/dbname
  const match = raw.match(/^mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/);
  if (!match) throw new Error('Cannot parse DATABASE_URL: ' + raw);
  const [, user, pass, host, port, db] = match;

  const conn = await mysql.createConnection({
    host,
    port: parseInt(port),
    user: decodeURIComponent(user),
    password: decodeURIComponent(pass),
    database: db,
  });

  const makeSql = (table) => `
    UPDATE \`${table}\` SET meal_plan_code = CASE
      WHEN meal_plan_breakfast=1 AND meal_plan_lunch=1 AND meal_plan_dinner=1 THEN 'AP'
      WHEN meal_plan_breakfast=1 AND meal_plan_dinner=1 THEN 'MAP'
      WHEN meal_plan_breakfast=1 THEN 'CP'
      ELSE 'EP'
    END
    WHERE meal_plan_code IS NULL
  `;

  const [r1] = await conn.execute(makeSql('dvi_itinerary_plan_details'));
  console.log('dvi_itinerary_plan_details updated:', r1.affectedRows, 'rows');

  const [r2] = await conn.execute(makeSql('dvi_confirmed_itinerary_plan_details'));
  console.log('dvi_confirmed_itinerary_plan_details updated:', r2.affectedRows, 'rows');

  await conn.end();
  console.log('Backfill complete.');
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
