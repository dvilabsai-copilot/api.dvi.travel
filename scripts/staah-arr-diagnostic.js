/**
 * STAAH ARR diagnostic script.
 * Fetches ARR_info for selected date windows and prints raw keys per data row,
 * including explicit amountAfterTax presence checks.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

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
const API_KEY = process.env.STAAH_API_KEY || '';
const ROOM_ID_RAW = process.env.STAAH_ROOM_ID || 'DELUXE';
const RATE_ID_RAW = process.env.STAAH_RATE_ID || 'CP';
const FETCH_URL = process.env.STAAH_FETCH_URL || 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.pl';
const REQUEST_TIMEOUT_MS = Number(process.env.STAAH_REQUEST_TIMEOUT_MS || 60000);

function normalizeExternalId(value) {
  return String(value || '').trim().replace(/_/g, '');
}

const ROOM_ID = normalizeExternalId(ROOM_ID_RAW) || 'DELUXE';
const RATE_ID = normalizeExternalId(RATE_ID_RAW) || 'CP';

const windows = [
  ['2026-07-20', '2026-07-20'],
  ['2026-07-21', '2026-07-21'],
  ['2026-08-10', '2026-08-10'],
  ['2026-08-11', '2026-08-11'],
  ['2026-09-01', '2026-09-03'],
  ['2026-09-02', '2026-09-04'],
  ['2026-10-05', '2026-10-05'],
  ['2026-10-06', '2026-10-06'],
];

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
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.write(body);
    req.end();
  });
}

function buildArrInfoPayload(fromDate, toDate) {
  return {
    propertyid: PROPERTY_ID,
    apikey: API_KEY,
    room_id: ROOM_ID,
    rate_id: RATE_ID,
    action: 'ARR_info',
    from_date: fromDate,
    to_date: toDate,
    version: '2',
  };
}

function hasAmountAfterTax(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.amountAfterTax !== undefined && row.amountAfterTax !== null) return true;
  if (row.amountaftertax !== undefined && row.amountaftertax !== null) return true;
  if (row.rates && typeof row.rates === 'object') {
    if (row.rates.amountAfterTax !== undefined && row.rates.amountAfterTax !== null) return true;
    if (row.rates.amountaftertax !== undefined && row.rates.amountaftertax !== null) return true;
  }
  return false;
}

async function main() {
  if (!API_KEY) {
    throw new Error('STAAH_API_KEY is required.');
  }

  console.log('STAAH ARR Diagnostic');
  console.log('Fetch URL:', FETCH_URL);
  console.log('Property:', PROPERTY_ID, 'Room:', ROOM_ID, 'Rate:', RATE_ID);

  for (const [fromDate, toDate] of windows) {
    const payload = buildArrInfoPayload(fromDate, toDate);
    console.log('\n=== Window', `${fromDate} -> ${toDate}`, '===');

    try {
      const res = await postJson(FETCH_URL, payload);
      console.log('HTTP Status:', res.status);

      const rows = Array.isArray(res.body?.data) ? res.body.data : [];
      console.log('Rows returned:', rows.length);

      let windowHasAmountAfterTax = false;

      rows.forEach((row, index) => {
        const keys = row && typeof row === 'object' ? Object.keys(row) : [];
        const dateValue = row && typeof row === 'object' ? (row.date || row.start_date || '-') : '-';
        const hasAAT = hasAmountAfterTax(row);
        if (hasAAT) windowHasAmountAfterTax = true;

        console.log(
          `  [${index}] date=${dateValue} keys=${keys.join(', ')} amountAfterTaxPresent=${hasAAT ? 'YES' : 'NO'}`,
        );
      });

      console.log('Window amountAfterTax presence:', windowHasAmountAfterTax ? 'YES' : 'NO');
    } catch (error) {
      console.log('Error:', error.message);
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
