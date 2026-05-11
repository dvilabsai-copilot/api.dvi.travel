/**
 * Manual-hotspot preview performance diagnostic script.
 * Usage: node docs/scripts/preview-perf-test.js
 *
 * Calls the preview endpoint and reports wall-clock time.
 * Check the backend console for [TIMELINE] log lines to see per-step breakdown.
 */

const http = require('http');

const BASE_URL = 'http://127.0.0.1:4006';
const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzgyOTI5NjksImV4cCI6MTc3ODg5Nzc2OX0.T8O8Gx5u4tplHXM7pVxgWZIQuKgvGVAZLfxdiYP64i4';

const PAYLOAD = {
  routeId: 3898,
  hotspotId: 31,
  anchorType: 'after_travel',
  anchorIndex: 0,
  allowTopPriorityRemoval: false,
  selectedHotspotIds: [31],
};

const PLAN_ID = 378;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: 4006,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${TOKEN}`,
        Accept: '*/*',
      },
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runTest(label, iteration) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Run #${iteration}: ${label}`);
  console.log('='.repeat(60));
  console.log('Payload:', JSON.stringify(PAYLOAD, null, 2));
  console.log('\n>>> [Check backend console for [TIMELINE] logs during this call]\n');

  const t0 = Date.now();
  let result;
  try {
    result = await post(`/api/v1/itineraries/${PLAN_ID}/manual-hotspot/preview`, PAYLOAD);
  } catch (err) {
    console.error('Request failed:', err.message);
    return;
  }

  const elapsed = Date.now() - t0;
  console.log(`Status: ${result.status}`);
  console.log(`⏱  Total wall-clock: ${elapsed} ms  (${(elapsed / 1000).toFixed(2)} s)`);

  const b = result.body;
  if (b && typeof b === 'object') {
    console.log('\nResponse summary:');
    console.log('  success:', b.success);
    console.log('  inserted:', b.inserted);
    console.log('  code:', b.code || '(none)');
    console.log('  message:', b.message);
    console.log('  fullTimeline rows:', Array.isArray(b.fullTimeline) ? b.fullTimeline.length : 'N/A');
    console.log(
      '  scheduledManualHotspots:',
      Array.isArray(b.resolution?.scheduledManualHotspots)
        ? b.resolution.scheduledManualHotspots.map((h) => h.name).join(', ')
        : 'N/A',
    );
    console.log(
      '  removedOptionalHotspots:',
      Array.isArray(b.resolution?.removedOptionalHotspots)
        ? b.resolution.removedOptionalHotspots.length
        : 'N/A',
    );
  }
  return elapsed;
}

async function main() {
  console.log('Manual-hotspot preview perf diagnostic');
  console.log('Plan ID:', PLAN_ID, '| Route ID:', PAYLOAD.routeId, '| Hotspot ID:', PAYLOAD.hotspotId);
  console.log('Server:', BASE_URL);

  // Warm-up + 3 timed runs
  const timings = [];
  for (let i = 1; i <= 3; i++) {
    const ms = await runTest('preview', i);
    if (ms !== undefined) timings.push(ms);
    if (i < 3) {
      // Brief pause so logs don't interleave
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (timings.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    timings.forEach((t, i) => console.log(`  Run ${i + 1}: ${t} ms`));
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
    console.log(`  Average: ${avg} ms`);
    console.log('\nNext step: grep backend console for "[TIMELINE]" and "[ManualInsertionOptimizer]"');
    console.log('to see which step takes most time per candidate simulation.');
  }
}

main().catch(console.error);
