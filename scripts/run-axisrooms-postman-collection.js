const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function varsToMap(collection) {
  const map = {};
  for (const v of collection.variable || []) {
    map[v.key] = String(v.value ?? '');
  }
  return map;
}

function interpolate(str, vars) {
  return String(str || '').replace(/\{\{\s*([^\}]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
  });
}

function normalizeUrl(rawUrl) {
  const withProtocolSafe = rawUrl.replace(/([^:])\/\/+?/g, '$1/');
  return withProtocolSafe.replace(':/', '://');
}

function extractRawUrl(req) {
  if (req.url && typeof req.url === 'string') return req.url;
  if (req.url && typeof req.url.raw === 'string') return req.url.raw;
  return '';
}

function summarizeBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function evaluate(name, statusCode, body) {
  const lowerName = String(name || '').toLowerCase();
  const statusField = body && typeof body === 'object' ? String(body.status || '').toLowerCase() : '';
  const messageField = body && typeof body === 'object' ? String(body.message || '').toLowerCase() : '';

  if (lowerName.includes('invalid-auth') || lowerName.includes('missing-auth')) {
    const ok = statusCode === 401 || statusField === 'failure' || messageField.includes('unauthorized');
    return { ok, expected: 'unauthorized/failure', actual: `http ${statusCode}, status=${statusField || 'n/a'}` };
  }

  if (lowerName.includes('invalid-property')) {
    const ok = statusField === 'failure' || messageField.includes('invalid property');
    return { ok, expected: 'invalid property failure', actual: `http ${statusCode}, status=${statusField || 'n/a'}` };
  }

  const ok = statusCode === 200 && statusField === 'success';
  return { ok, expected: 'http 200 + status=success', actual: `http ${statusCode}, status=${statusField || 'n/a'}` };
}

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error('Usage: node scripts/run-axisrooms-postman-collection.js <collection.json>');
  }

  const collection = readJson(path.resolve(filePath));
  const vars = varsToMap(collection);
  const items = Array.isArray(collection.item) ? collection.item : [];

  const results = [];
  for (const item of items) {
    const req = item.request || {};
    const method = String(req.method || 'GET').toUpperCase();
    const rawUrl = extractRawUrl(req);
    const url = normalizeUrl(interpolate(rawUrl, vars));

    const headers = {};
    for (const h of req.header || []) {
      if (!h || !h.key) continue;
      headers[h.key] = interpolate(h.value || '', vars);
    }

    let body;
    if (req.body && req.body.mode === 'raw') {
      body = interpolate(req.body.raw || '', vars);
    }

    const started = Date.now();
    let statusCode = 0;
    let parsedBody = null;
    let error = null;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
      });
      statusCode = response.status;
      const text = await response.text();
      parsedBody = summarizeBody(text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const elapsedMs = Date.now() - started;
    const evalResult = error
      ? { ok: false, expected: 'reachable endpoint', actual: error }
      : evaluate(item.name, statusCode, parsedBody);

    results.push({
      name: item.name,
      method,
      url,
      elapsedMs,
      statusCode,
      ok: evalResult.ok,
      expected: evalResult.expected,
      actual: evalResult.actual,
      body: parsedBody,
      error,
    });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log(JSON.stringify({
    summary: {
      total: results.length,
      passed,
      failed,
    },
    results,
  }, null, 2));
}

run().catch((e) => {
  console.error('Runner failed:', e.message || e);
  process.exit(1);
});
