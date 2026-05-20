/**
 * Manual hotspot preview verification script.
 *
 * Usage:
 *   node docs/scripts/test-manual-hotspot-preview-fix.js
 *
 * Optional env overrides:
 *   BASE_URL=http://127.0.0.1:4006
 *   PLAN_ID=379
 *   ROUTE_ID=3898
 *   HOTSPOT_ID=31
 *   TOKEN=<jwt>
 *   RUNS=3
 */

const http = require('http');
const { performance } = require('node:perf_hooks');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:4006';
const PLAN_ID = Number(process.env.PLAN_ID || 379);
const ROUTE_ID = Number(process.env.ROUTE_ID || 3898);
const HOTSPOT_ID = Number(process.env.HOTSPOT_ID || 31);
const RUNS = Math.max(1, Number(process.env.RUNS || 3));
const TOKEN =
  process.env.TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzgyOTI5NjksImV4cCI6MTc3ODg5Nzc2OX0.T8O8Gx5u4tplHXM7pVxgWZIQuKgvGVAZLfxdiYP64i4';

const payload = {
  routeId: ROUTE_ID,
  hotspotId: HOTSPOT_ID,
  anchorType: 'after_travel',
  anchorIndex: 0,
  allowTopPriorityRemoval: false,
  selectedHotspotIds: [HOTSPOT_ID],
};

function parseBaseUrl(input) {
  const url = new URL(input);
  return {
    hostname: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    protocol: url.protocol,
    basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''),
  };
}

function requestJson(method, requestPath, body) {
  const target = parseBaseUrl(BASE_URL);
  const rawBody = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.basePath}${requestPath}`,
        method,
        headers: {
          Accept: '*/*',
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = raw;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // Keep raw text when response is not JSON.
          }

          resolve({
            status: Number(res.statusCode || 0),
            headers: res.headers,
            body: parsed,
          });
        });
      },
    );

    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') {
    return { type: typeof body, body };
  }

  return {
    success: body.success,
    inserted: body.inserted,
    code: body.code || null,
    message: body.message || null,
    timelineRows: Array.isArray(body.fullTimeline) ? body.fullTimeline.length : null,
    scheduledManualHotspots: Array.isArray(body.resolution?.scheduledManualHotspots)
      ? body.resolution.scheduledManualHotspots.map((row) => row.name || row.id)
      : null,
    unscheduledManualHotspots: Array.isArray(body.resolution?.unscheduledManualHotspots)
      ? body.resolution.unscheduledManualHotspots.map((row) => row.name || row.id)
      : null,
    removedOptionalHotspots: Array.isArray(body.resolution?.removedOptionalHotspots)
      ? body.resolution.removedOptionalHotspots.length
      : null,
  };
}

async function runOnce(iteration) {
  const requestPath = `/api/v1/itineraries/${PLAN_ID}/manual-hotspot/preview`;
  const startedAt = performance.now();
  const response = await requestJson('POST', requestPath, payload);
  const elapsedMs = Math.round(performance.now() - startedAt);

  console.log(`\nRun ${iteration}/${RUNS}`);
  console.log(`  Status: ${response.status}`);
  console.log(`  Elapsed: ${elapsedMs} ms`);
  console.log('  Summary:', JSON.stringify(summarizeBody(response.body), null, 2));

  if (response.status >= 400) {
    console.log('  Raw error body:', typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2));
  }

  return {
    status: response.status,
    elapsedMs,
    body: response.body,
  };
}

async function main() {
  console.log('Manual hotspot preview verification');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  Plan ID: ${PLAN_ID}`);
  console.log(`  Route ID: ${ROUTE_ID}`);
  console.log(`  Hotspot ID: ${HOTSPOT_ID}`);
  console.log(`  Runs: ${RUNS}`);

  const results = [];
  for (let index = 1; index <= RUNS; index += 1) {
    results.push(await runOnce(index));
  }

  const timings = results.map((row) => row.elapsedMs);
  const averageMs = Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length);
  const failed = results.find((row) => row.status < 200 || row.status >= 300);

  console.log('\nSummary');
  console.log(`  Average elapsed: ${averageMs} ms`);
  console.log(`  Min elapsed: ${Math.min(...timings)} ms`);
  console.log(`  Max elapsed: ${Math.max(...timings)} ms`);

  if (failed) {
    console.error(`\nVerification failed with status ${failed.status}.`);
    process.exitCode = 1;
    return;
  }

  console.log('\nVerification passed: endpoint returned a 2xx response for all runs.');
}

main().catch((error) => {
  console.error('Script failed:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});