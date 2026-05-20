// debug_hotel_details.js
// Calls GET /api/v1/itineraries/hotel_details/:quoteId and prints detailed debug output.
// Does NOT modify any backend code.
//
// Usage:
//   node debug_hotel_details.js                        (uses DVI2026037 on 127.0.0.1:4006)
//   node debug_hotel_details.js DVI2026012             (custom quoteId)
//   BASE_URL=http://localhost:4006 node debug_hotel_details.js DVI2026012

require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const QUOTE_ID     = process.argv[2] || 'DVI2026037';
const BASE_URL_ENV = process.env.BASE_URL || 'http://127.0.0.1:4006';
const FULL_URL     = `${BASE_URL_ENV}/api/v1/itineraries/hotel_details/${QUOTE_ID}`;
const SAVE_RAW     = true; // set false to skip writing raw JSON to disk
const RAW_FILE     = path.join(process.cwd(), `debug-hotel-details-${QUOTE_ID}-${Date.now()}.json`);

// ── Auth token (same as trigger_optimization.js) ──────────────────────────────
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5OCIsImVtYWlsIjoiZGVtb0BkdmkuY28uaW4iLCJyb2xlIjo0LCJhZ2VudElkIjo4LCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzQwNDk3MDUsImV4cCI6MTc3NDY1NDUwNX0.XAR4bE8Ua5iYR5eVUXlTtsxV20XtFsqyiAw5PUmsXHc';

function makeRequest(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/json',
      },
      timeout: 60000,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 60s')); });
    req.on('error', reject);
    req.end();
  });
}

function sep(ch = '─', n = 72) { return ch.repeat(n); }

async function main() {
  console.log('\n' + sep('═'));
  console.log('  DEBUG: GET hotel_details');
  console.log(`  URL     : ${FULL_URL}`);
  console.log(`  Quote ID: ${QUOTE_ID}`);
  console.log(`  Time    : ${new Date().toISOString()}`);
  console.log(sep('═'));

  let result;
  try {
    result = await makeRequest(FULL_URL);
  } catch (err) {
    console.error(`\n❌ HTTP request failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n  HTTP Status: ${result.status}`);

  if (result.status !== 200) {
    console.log('\n⚠️  Non-200 response. Raw body:');
    console.log(result.body);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.body);
  } catch (e) {
    console.error('\n❌ Failed to parse response JSON:', e.message);
    console.log('Raw:', result.body.substring(0, 500));
    process.exit(1);
  }

  // ── Save raw response ──────────────────────────────────────────────────────
  if (SAVE_RAW) {
    fs.writeFileSync(RAW_FILE, JSON.stringify(parsed, null, 2));
    console.log(`  Raw JSON saved to: ${path.basename(RAW_FILE)}`);
  }

  // ── Top-level fields ───────────────────────────────────────────────────────
  console.log('\n' + sep());
  console.log('  TOP-LEVEL RESPONSE FIELDS');
  console.log(sep());
  console.log(`  quoteId           : ${parsed.quoteId}`);
  console.log(`  planId            : ${parsed.planId}`);
  console.log(`  hotelRatesVisible : ${parsed.hotelRatesVisible}`);
  console.log(`  totalRoomCount    : ${parsed.totalRoomCount}`);

  // ── Hotel tabs ─────────────────────────────────────────────────────────────
  const tabs = parsed.hotelTabs || [];
  console.log('\n' + sep());
  console.log(`  HOTEL TABS (${tabs.length} packages)`);
  console.log(sep());
  if (tabs.length === 0) {
    console.log('  ⚠️  No hotel tabs returned');
  } else {
    tabs.forEach(t => {
      console.log(`  Group ${t.groupType} | ${String(t.label).padEnd(18)} | totalAmount: ₹${Number(t.totalAmount).toFixed(2)}`);
    });
  }

  // ── Hotel rows analysis ────────────────────────────────────────────────────
  const hotels = parsed.hotels || [];
  const totalRows      = hotels.length;
  const zeroIdRows     = hotels.filter(h => Number(h.hotelId) === 0);
  const noAvailRows    = hotels.filter(h => h.hotelName === 'No Hotels Available');
  const realRows       = hotels.filter(h => Number(h.hotelId) > 0);
  const destinations   = [...new Set(hotels.map(h => h.destination).filter(Boolean))];
  const providers      = [...new Set(hotels.map(h => h.provider).filter(Boolean))];

  console.log('\n' + sep());
  console.log(`  HOTEL ROWS ANALYSIS (${totalRows} total)`);
  console.log(sep());
  console.log(`  Total rows              : ${totalRows}`);
  console.log(`  hotelId = 0 (fallback)  : ${zeroIdRows.length}`);
  console.log(`  "No Hotels Available"   : ${noAvailRows.length}`);
  console.log(`  Real hotelId > 0        : ${realRows.length}`);
  console.log(`  Distinct destinations   : ${destinations.length > 0 ? destinations.join(', ') : '(none)'}`);
  console.log(`  Distinct providers      : ${providers.length > 0 ? providers.join(', ') : '(none)'}`);

  // ── Overall verdict ────────────────────────────────────────────────────────
  console.log('\n' + sep());
  console.log('  VERDICT');
  console.log(sep());
  if (totalRows === 0) {
    console.log('  ⚠️  EMPTY — No hotel rows at all');
  } else if (realRows.length === 0) {
    console.log('  ❌ ALL FALLBACK — Every row is "No Hotels Available" (hotelId=0)');
    console.log('     Root cause: TBO search returned 0 results for all routes');
  } else if (zeroIdRows.length > 0) {
    console.log(`  ⚠️  MIXED — ${realRows.length} real hotel(s) + ${zeroIdRows.length} fallback row(s)`);
  } else {
    console.log('  ✅ REAL HOTELS — All rows have real hotelId > 0');
  }

  // ── Grouped summary by groupType + destination ─────────────────────────────
  console.log('\n' + sep());
  console.log('  GROUPED SUMMARY (groupType × destination)');
  console.log(sep());
  const grouped = {};
  hotels.forEach(h => {
    const key = `Group${h.groupType}`;
    if (!grouped[key]) grouped[key] = {};
    const dest = h.destination || '(unknown)';
    if (!grouped[key][dest]) grouped[key][dest] = { count: 0, realCount: 0, names: [] };
    grouped[key][dest].count++;
    if (Number(h.hotelId) > 0) {
      grouped[key][dest].realCount++;
      grouped[key][dest].names.push(`${h.hotelName} [${h.provider}] ₹${h.totalHotelCost}`);
    } else {
      grouped[key][dest].names.push(`FALLBACK (${h.hotelName})`);
    }
  });

  Object.entries(grouped).forEach(([group, dests]) => {
    console.log(`\n  ${group}:`);
    Object.entries(dests).forEach(([dest, info]) => {
      const badge = info.realCount > 0 ? '✅' : '❌';
      console.log(`    ${badge} ${dest} — ${info.count} row(s), ${info.realCount} real`);
      info.names.forEach(n => console.log(`       · ${n}`));
    });
  });

  // ── Real hotel sample ──────────────────────────────────────────────────────
  if (realRows.length > 0) {
    console.log('\n' + sep());
    console.log(`  REAL HOTEL SAMPLES (first 5 of ${realRows.length})`);
    console.log(sep());
    realRows.slice(0, 5).forEach(h => {
      console.log(`  hotelId=${h.hotelId} | ${h.hotelName} | ${h.destination} | ${h.provider} | ₹${h.totalHotelCost} | bookingCode=${h.bookingCode}`);
    });
  }

  console.log('\n' + sep('═') + '\n');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
