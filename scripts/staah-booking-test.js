/**
 * STAAH Booking Certification Test Script
 * Run this on the production server (whitelisted IP).
 *
 * Usage:
 *   node scripts/staah-booking-test.js
 *
 * Optional env overrides:
 *   STAAH_PROPERTY_ID=STAAHTESTHOTEL1
 *   STAAH_API_KEY=Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH
 *   STAAH_BOOKING_URL=https://channels-stage.staah.net/booking/getapi/reservation/v2
 *   STAAH_ROOM_ID=DELUXE_ROOM
 *   STAAH_RATE_ID=CP_PLAN
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const PROPERTY_ID = process.env.STAAH_PROPERTY_ID || 'STAAHTESTHOTEL1';
const API_KEY     = process.env.STAAH_API_KEY     || '';
const ROOM_ID     = process.env.STAAH_ROOM_ID     || 'DELUXE_ROOM';
const RATE_ID     = process.env.STAAH_RATE_ID     || 'CP_PLAN';
const BOOKING_URL = process.env.STAAH_BOOKING_URL || 'https://channels-stage.staah.net/booking/getapi/reservation/v2';

const OUT_DIR = path.join(__dirname, '..', `staah-booking-cert-${Date.now()}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function saveEvidence(name, request, response) {
  const reqFile = path.join(OUT_DIR, `${name}_request.json`);
  const resFile = path.join(OUT_DIR, `${name}_response.json`);
  fs.writeFileSync(reqFile, JSON.stringify(request, null, 2), 'utf8');
  fs.writeFileSync(resFile, JSON.stringify({ status: response.status, body: response.body }, null, 2), 'utf8');
  console.log(`  Request  → ${reqFile}`);
  console.log(`  Response → ${resFile}`);
}

function makeBookingId(label) {
  return `DVI-CERT-${label.toUpperCase().replace(/\s+/g, '-')}-${Date.now()}`;
}

async function runTest(label, payload) {
  console.log(`\n=== ${label} ===`);
  console.log(`POST ${BOOKING_URL}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  try {
    const res = await postJson(BOOKING_URL, payload);
    const pass = res.status === 200;
    console.log(`Status : ${res.status}  →  ${pass ? 'PASS ✓' : 'FAIL ✗'}`);
    console.log('Response:', JSON.stringify(res.body, null, 2));
    saveEvidence(label.toLowerCase().replace(/\s+/g, '_'), payload, res);
    return { label, status: res.status, pass, body: res.body };
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    saveEvidence(label.toLowerCase().replace(/\s+/g, '_'), payload, { status: 'ERR', body: err.message });
    return { label, status: 'ERR', pass: false, body: err.message };
  }
}

async function main() {
  console.log('STAAH Booking Certification Test');
  console.log('==================================');
  console.log(`Property ID : ${PROPERTY_ID}`);
  console.log(`API Key     : ${API_KEY}`);
  console.log(`Booking URL : ${BOOKING_URL}`);
  console.log(`Output dir  : ${OUT_DIR}`);

  const results = [];

  // ── Scenario 1: Single Room, Single Rate Plan ─────────────────────
  const bookingId1 = makeBookingId('S1');

  results.push(await runTest('S1_01_Pre-Book', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId1,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-01',
        checkOut: '2026-12-03',
        adults: 2,
        children: 0,
        status: 'pending',
      }],
    },
  }));

  results.push(await runTest('S1_02_Confirm', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId1,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-01',
        checkOut: '2026-12-03',
        adults: 2,
        children: 0,
        status: 'confirmed',
      }],
    },
  }));

  results.push(await runTest('S1_03_Pre-Modify', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId1,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-02',
        checkOut: '2026-12-05',
        adults: 2,
        children: 0,
        status: 'pending_modify',
      }],
    },
  }));

  results.push(await runTest('S1_04_Modify', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId1,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-02',
        checkOut: '2026-12-05',
        adults: 2,
        children: 0,
        status: 'modified',
      }],
    },
  }));

  results.push(await runTest('S1_05_Cancel', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId1,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-02',
        checkOut: '2026-12-05',
        adults: 2,
        children: 0,
        status: 'cancelled',
      }],
    },
  }));

  // ── Scenario 2: With Extra Adult/Child ────────────────────────────
  const bookingId2 = makeBookingId('S2');

  results.push(await runTest('S2_01_Confirm', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId2,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-10',
        checkOut: '2026-12-12',
        adults: 2,
        children: 1,
        extraAdult: 1,
        extraChild: 1,
        status: 'confirmed',
      }],
    },
  }));

  results.push(await runTest('S2_02_Cancel', {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [{
        bookingId: bookingId2,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        checkIn: '2026-12-10',
        checkOut: '2026-12-12',
        adults: 2,
        children: 1,
        status: 'cancelled',
      }],
    },
  }));

  // ─── Summary ──────────────────────────────────────────────────────
  console.log('\n\n================================');
  console.log('SUMMARY');
  console.log('================================');
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  for (const r of results) {
    console.log(`  ${r.pass ? '✓ PASS' : '✗ FAIL'} [${r.status}]  ${r.label}`);
  }
  console.log(`\nTotal: ${results.length} | Pass: ${pass} | Fail: ${fail}`);
  console.log(`Evidence folder: ${OUT_DIR}`);

  // Write summary JSON
  const summaryFile = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({ generatedAt: new Date().toISOString(), propertyId: PROPERTY_ID, url: BOOKING_URL, results }, null, 2), 'utf8');
  console.log(`Summary JSON  : ${summaryFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
