#!/usr/bin/env node

/**
 * Safe clone of one dvi_users admin login into a demo login.
 *
 * Usage:
 *   node clone/clone-tbo-demo-user.js --dry-run
 *   node clone/clone-tbo-demo-user.js
 */

require('dotenv').config();

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const SOURCE_EMAIL = process.env.CLONE_SOURCE_EMAIL || 'admin@dvi.co.in';
const TARGET_EMAIL = process.env.CLONE_TARGET_EMAIL || 'tbo_demo@dvi.travel';
const TARGET_PASSWORD = process.env.CLONE_TARGET_PASSWORD || 'demo@Tbo123';
const TARGET_USERNAME =
  process.env.CLONE_TARGET_USERNAME || deriveUsernameFromEmail(TARGET_EMAIL);
const BCRYPT_ROUNDS = Number(process.env.CLONE_BCRYPT_ROUNDS || 10);
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

function deriveUsernameFromEmail(email) {
  const local = String(email || '').split('@')[0] || 'demo_user';
  return local.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing.');
  }

  const url = new URL(databaseUrl);
  const protocol = url.protocol.replace(':', '');
  if (protocol !== 'mysql') {
    throw new Error(`Unsupported DATABASE_URL protocol: ${url.protocol}`);
  }

  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

async function generateUniqueHexToken(connection, columnName, bytes) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = crypto.randomBytes(bytes).toString('hex');
    const [rows] = await connection.execute(
      `SELECT userID FROM dvi_users WHERE ${columnName} = ? LIMIT 1`,
      [token],
    );
    if (rows.length === 0) {
      return token;
    }
  }

  throw new Error(`Could not generate a unique ${columnName} after multiple attempts.`);
}

function printablePayload(payload) {
  return {
    ...payload,
    createdon:
      payload.createdon instanceof Date
        ? payload.createdon.toISOString()
        : payload.createdon,
  };
}

async function main() {
  const conn = await mysql.createConnection(parseDatabaseUrl(process.env.DATABASE_URL));

  try {
    const [sourceRows] = await conn.execute(
      'SELECT * FROM dvi_users WHERE useremail = ? ORDER BY userID ASC LIMIT 1',
      [SOURCE_EMAIL],
    );

    if (sourceRows.length === 0) {
      throw new Error(`Source user not found for email: ${SOURCE_EMAIL}`);
    }

    const source = sourceRows[0];

    const [targetRows] = await conn.execute(
      'SELECT userID, deleted FROM dvi_users WHERE useremail = ? ORDER BY userID ASC LIMIT 1',
      [TARGET_EMAIL],
    );

    if (targetRows.length > 0) {
      throw new Error(
        `Target email already exists: ${TARGET_EMAIL} (userID=${targetRows[0].userID}, deleted=${targetRows[0].deleted})`,
      );
    }

    const passwordHash = await bcrypt.hash(TARGET_PASSWORD, BCRYPT_ROUNDS);
    const freshUserToken = await generateUniqueHexToken(conn, 'usertoken', 16);

    const now = new Date();

    const insertPayload = {
      guide_id: source.guide_id,
      vendor_id: source.vendor_id,
      staff_id: source.staff_id,
      agent_id: source.agent_id,
      usertoken: freshUserToken,
      user_profile: source.user_profile,
      username: TARGET_USERNAME,
      useremail: TARGET_EMAIL,
      password: passwordHash,
      roleID: source.roleID,
      google_auth_code: null,
      userlogtime: null,
      userlogkey: null,
      last_loggedon: null,
      userapproved: source.userapproved,
      userbanned: source.userbanned,
      createdby: source.createdby,
      createdon: now,
      status: source.status,
      deleted: source.deleted,
    };

    console.log('Source user summary:');
    console.log(
      JSON.stringify(
        {
          userID: source.userID,
          username: source.username,
          useremail: source.useremail,
          roleID: source.roleID,
          status: source.status,
          deleted: source.deleted,
        },
        null,
        2,
      ),
    );

    console.log('\nFinal insert payload:');
    console.log(JSON.stringify(printablePayload(insertPayload), null, 2));

    const columns = [
      'guide_id',
      'vendor_id',
      'staff_id',
      'agent_id',
      'usertoken',
      'user_profile',
      'username',
      'useremail',
      'password',
      'roleID',
      'google_auth_code',
      'userlogtime',
      'userlogkey',
      'last_loggedon',
      'userapproved',
      'userbanned',
      'createdby',
      'createdon',
      'status',
      'deleted',
    ];

    const values = columns.map((c) => insertPayload[c]);
    const placeholders = columns.map(() => '?').join(', ');

    const insertSql = `
INSERT INTO dvi_users (${columns.join(', ')})
SELECT ${placeholders}
FROM DUAL
WHERE NOT EXISTS (
  SELECT 1 FROM dvi_users WHERE useremail = ?
);`.trim();

    const sqlPreview = conn.format(insertSql, [...values, TARGET_EMAIL]);
    console.log('\nEquivalent production SQL (idempotent-style):');
    console.log(sqlPreview);

    if (DRY_RUN) {
      console.log('\nDry-run mode enabled. No row inserted.');
      return;
    }

    const [result] = await conn.execute(insertSql, [...values, TARGET_EMAIL]);
    if (result.affectedRows !== 1) {
      throw new Error(
        `Insert skipped (affectedRows=${result.affectedRows}). Likely target email was inserted concurrently.`,
      );
    }

    const [verifyRows] = await conn.execute(
      'SELECT userID, username, useremail, roleID, status, deleted FROM dvi_users WHERE useremail = ? ORDER BY userID DESC LIMIT 1',
      [TARGET_EMAIL],
    );

    console.log('\nInsert complete. New user row:');
    console.log(JSON.stringify(verifyRows[0], null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
