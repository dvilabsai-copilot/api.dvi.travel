// Backfill missing canonical meal-plan codes and normalize legacy flags.
// Dry run: node scripts/backfill-meal-plan-code.js [--plan-id=10072]
// Apply:   node scripts/backfill-meal-plan-code.js --apply [--plan-id=10072]
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const planIdArg = process.argv.find((arg) => arg.startsWith('--plan-id='));
const PLAN_ID = planIdArg ? Number(planIdArg.split('=')[1]) : null;

if (planIdArg && (!Number.isInteger(PLAN_ID) || PLAN_ID <= 0)) {
  throw new Error('--plan-id must be a positive integer');
}

const TABLES = [
  { name: 'dvi_itinerary_plan_details', idColumn: 'itinerary_plan_ID' },
  { name: 'dvi_confirmed_itinerary_plan_details', idColumn: 'itinerary_plan_ID' },
];

function getConnectionConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL not set in .env');

  const parsed = new URL(raw);
  if (parsed.protocol !== 'mysql:') throw new Error('DATABASE_URL must use mysql://');

  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
  };
}

function scopeSql(table) {
  return PLAN_ID ? ` AND \`${table.idColumn}\` = ?` : '';
}

function scopeParams() {
  return PLAN_ID ? [PLAN_ID] : [];
}

function expectedFlagSql(flag) {
  const values = {
    breakfast: `CASE UPPER(TRIM(meal_plan_code)) WHEN 'CP' THEN 1 WHEN 'EP' THEN 0 WHEN 'MAP' THEN 1 WHEN 'AP' THEN 1 END`,
    lunch: `CASE UPPER(TRIM(meal_plan_code)) WHEN 'CP' THEN 0 WHEN 'EP' THEN 0 WHEN 'MAP' THEN 0 WHEN 'AP' THEN 1 END`,
    dinner: `CASE UPPER(TRIM(meal_plan_code)) WHEN 'CP' THEN 0 WHEN 'EP' THEN 0 WHEN 'MAP' THEN 1 WHEN 'AP' THEN 1 END`,
  };
  return values[flag];
}

async function inspectTable(conn, table) {
  const scope = scopeSql(table);
  const params = scopeParams();
  const [missingCodeRows] = await conn.execute(
    `SELECT COUNT(*) AS row_count FROM \`${table.name}\`
     WHERE meal_plan_code IS NULL${scope}`,
    params,
  );
  const [inconsistentFlagRows] = await conn.execute(
    `SELECT COUNT(*) AS row_count FROM \`${table.name}\`
     WHERE UPPER(TRIM(meal_plan_code)) IN ('CP', 'EP', 'MAP', 'AP')
       AND (
         meal_plan_breakfast <> ${expectedFlagSql('breakfast')}
         OR meal_plan_lunch <> ${expectedFlagSql('lunch')}
         OR meal_plan_dinner <> ${expectedFlagSql('dinner')}
       )${scope}`,
    params,
  );

  return {
    table: table.name,
    missingCanonicalCode: Number(missingCodeRows[0]?.row_count || 0),
    inconsistentCanonicalFlags: Number(inconsistentFlagRows[0]?.row_count || 0),
  };
}

async function applyTable(conn, table) {
  const scope = scopeSql(table);
  const params = scopeParams();
  const [codeResult] = await conn.execute(
    `UPDATE \`${table.name}\` SET meal_plan_code = CASE
       WHEN meal_plan_breakfast=1 AND meal_plan_lunch=1 AND meal_plan_dinner=1 THEN 'AP'
       WHEN meal_plan_breakfast=1 AND ((meal_plan_lunch=1 AND meal_plan_dinner=0) OR (meal_plan_lunch=0 AND meal_plan_dinner=1)) THEN 'MAP'
       WHEN meal_plan_breakfast=1 AND meal_plan_lunch=0 AND meal_plan_dinner=0 THEN 'CP'
       WHEN meal_plan_breakfast=0 AND meal_plan_lunch=0 AND meal_plan_dinner=0 THEN 'EP'
       ELSE NULL
     END
     WHERE meal_plan_code IS NULL${scope}`,
    params,
  );
  const [flagResult] = await conn.execute(
    `UPDATE \`${table.name}\` SET
       meal_plan_breakfast = ${expectedFlagSql('breakfast')},
       meal_plan_lunch = ${expectedFlagSql('lunch')},
       meal_plan_dinner = ${expectedFlagSql('dinner')}
     WHERE UPPER(TRIM(meal_plan_code)) IN ('CP', 'EP', 'MAP', 'AP')
       AND (
         meal_plan_breakfast <> ${expectedFlagSql('breakfast')}
         OR meal_plan_lunch <> ${expectedFlagSql('lunch')}
         OR meal_plan_dinner <> ${expectedFlagSql('dinner')}
       )${scope}`,
    params,
  );

  return {
    table: table.name,
    canonicalCodesFilled: Number(codeResult.affectedRows || 0),
    canonicalFlagsNormalized: Number(flagResult.affectedRows || 0),
  };
}

async function run() {
  const conn = await mysql.createConnection(getConnectionConfig());
  try {
    const before = [];
    for (const table of TABLES) before.push(await inspectTable(conn, table));
    console.log(JSON.stringify({ mode: APPLY ? 'APPLY' : 'DRY_RUN', planId: PLAN_ID, before }, null, 2));

    if (!APPLY) {
      console.log('Dry run only. Re-run with --apply after reviewing the counts.');
      return;
    }

    await conn.beginTransaction();
    try {
      const applied = [];
      for (const table of TABLES) applied.push(await applyTable(conn, table));
      await conn.commit();
      console.log(JSON.stringify({ applied }, null, 2));
    } catch (error) {
      await conn.rollback();
      throw error;
    }

    const after = [];
    for (const table of TABLES) after.push(await inspectTable(conn, table));
    console.log(JSON.stringify({ after }, null, 2));
  } finally {
    await conn.end();
  }
}

run().catch((error) => {
  console.error('Backfill failed:', error.message);
  process.exitCode = 1;
});
