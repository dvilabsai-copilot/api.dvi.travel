const fs = require('fs');
const path = require('path');

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function loadPayload() {
  const payloadFile =
    process.env.PAYLOAD_FILE ||
    process.env.ITIN_PAYLOAD_FILE ||
    process.env.REGRESSION_PAYLOAD_FILE ||
    '';

  if (payloadFile) {
    const resolved = path.resolve(payloadFile);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.payload ? parsed.payload : parsed;
  }

  throw new Error('Missing payload file. Set PAYLOAD_FILE or ITIN_PAYLOAD_FILE.');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function ensureToken(apiBase) {
  const email = String(process.env.PROD_EMAIL || process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.PROD_PASSWORD || process.env.DVI_PASSWORD || '').trim();
  if (!password) {
    throw new Error('Missing DVI_PASSWORD');
  }

  const resp = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await resp.text();
  const payload = safeJsonParse(text);
  const token =
    payload?.data?.accessToken ||
    payload?.accessToken ||
    payload?.token ||
    payload?.data?.token ||
    payload?.data?.jwt ||
    payload?.jwt ||
    null;

  if (!token) {
    throw new Error(`Unable to obtain bearer token via login. status=${resp.status}`);
  }

  return token;
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL) || 'http://127.0.0.1:4006';
  const apiBase = `${baseUrl}/api/v1`;
  const token = String(process.env.REGRESSION_BEARER_TOKEN || '').trim() || (await ensureToken(apiBase));

  const payload = loadPayload();
  const resultFile = process.env.RESULT_FILE || process.env.REGRESSION_RESULT_FILE || '';
  const url = `${apiBase}/itineraries/?type=itineary_basic_info`;

  console.log('[TRIGGER_ITIN_BUILD] URL', url);

  let response;
  let text = '';
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    text = await response.text();
  } catch (err) {
    console.error('[TRIGGER_ITIN_BUILD] Request failed:', err?.message || String(err));
    if (resultFile) {
      try {
        fs.writeFileSync(path.resolve(resultFile), JSON.stringify({ error: err?.message || String(err) }, null, 2), 'utf8');
      } catch {
        // ignore write errors on request failure
      }
    }
    process.exit(1);
  }

  console.log('[TRIGGER_ITIN_BUILD] status', response.status);

  const parsed = safeJsonParse(text);
  if (resultFile) {
    try {
      fs.writeFileSync(path.resolve(resultFile), text, 'utf8');
    } catch (writeErr) {
      console.error('[TRIGGER_ITIN_BUILD] Failed to write result file:', writeErr.message);
    }
  }

  if (parsed) {
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(text);
  }

  const responseSummary = {
    quoteId: parsed?.quoteId || parsed?.data?.quoteId || parsed?.response?.quoteId || null,
    planId: parsed?.planId || parsed?.data?.planId || parsed?.response?.planId || null,
    successMarker:
      parsed?.success ??
      parsed?.ok ??
      parsed?.data?.success ??
      parsed?.data?.ok ??
      parsed?.response?.success ??
      parsed?.response?.ok ??
      parsed?.vehicleBuildStatus ??
      parsed?.data?.vehicleBuildStatus ??
      parsed?.response?.vehicleBuildStatus ??
      parsed?.message ??
      parsed?.data?.message ??
      parsed?.response?.message ??
      null,
  };
  console.log('[TRIGGER_ITIN_BUILD] response summary', responseSummary);

  const hasExpectedIdentifiers =
    responseSummary.quoteId != null &&
    responseSummary.planId != null &&
    (responseSummary.successMarker != null || response.ok);

  if (!response.ok) {
    console.error('[TRIGGER_ITIN_BUILD] Non-2xx build response');
    process.exit(1);
  }

  if (!parsed || !hasExpectedIdentifiers) {
    console.error('[TRIGGER_ITIN_BUILD] Missing expected response fields or invalid JSON');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[TRIGGER_ITIN_BUILD] Unhandled failure:', err?.stack || err?.message || String(err));
  process.exit(1);
});
