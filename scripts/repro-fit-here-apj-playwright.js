const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const LOGIN_URL = process.env.FIT_LOGIN_URL || 'http://127.0.0.1:4006/api/v1/auth/login';
const PREVIEW_URL =
  process.env.FIT_PREVIEW_URL ||
  'http://127.0.0.1:4006/api/v1/itineraries/9774/manual-hotspot/fit-preview';
const CONFIRM_URL =
  process.env.FIT_CONFIRM_URL ||
  'http://127.0.0.1:4006/api/v1/itineraries/9774/manual-hotspot/fit-confirm';
const ITINERARY_URL =
  process.env.FIT_ITINERARY_URL ||
  'http://localhost:8080/itinerary-details/DVI2026071';
const USER_EMAIL = process.env.FIT_USER_EMAIL || 'admin@dvi.co.in';
const USER_PASSWORD = process.env.FIT_USER_PASSWORD || 'Keerthi@2404ias';
const HEADLESS = String(process.env.HEADLESS || 'true').trim().toLowerCase() !== 'false';
const DO_CONFIRM = String(process.env.FIT_DO_CONFIRM || 'false').trim().toLowerCase() === 'true';

const DEFAULT_PREVIEW_PAYLOAD = {
  routeId: 7761,
  selectedHotspotId: 41,
  anchor: {
    anchorType: 'BETWEEN_ROWS',
    anchorIntent: 'AFTER_ATTRACTION',
    anchorIndex: 3,
    anchorFrom: 'Meenakshi Amman Temple',
    anchorTo: 'Gandhi Museum',
    anchorLabel: 'After Meenakshi Amman Temple',
    anchorTimeRange: '09:30 AM - 11:00 AM',
    afterRowType: 'attraction',
    beforeRowType: 'hotspot',
    afterHotspotId: 26,
    afterRouteHotspotId: 122661,
    beforeHotspotId: 31,
    beforeRouteHotspotId: 122669,
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};

const DEFAULT_CONFIRM_PAYLOAD = {
  allowTimingRisk: false,
  allowClosedHotspotConflict: false,
  allowPriorityRemoval: true,
  acknowledgedRemovedHotspotIds: [27],
};

function parseJsonPayload(text, sourceLabel) {
  if (!String(text || '').trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error?.message || error}`);
  }
}

function loadJsonPayload(fallback, fileEnvNames, textEnvNames) {
  for (const envName of fileEnvNames) {
    const payloadFile = String(process.env[envName] || '').trim();
    if (!payloadFile) continue;
    return JSON.parse(fs.readFileSync(path.resolve(payloadFile), 'utf8'));
  }

  for (const envName of textEnvNames) {
    const rawText = String(process.env[envName] || '').trim();
    if (!rawText) continue;
    return parseJsonPayload(rawText, envName);
  }

  return fallback;
}

function unwrapJson(value) {
  let current = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (!trimmed) return {};
    current = JSON.parse(trimmed);
  }
  return current ?? {};
}

function getRemovedHotspotIdsFromPayload(payloadLike) {
  const ids = [
    ...(Array.isArray(payloadLike?.removedHotspots) ? payloadLike.removedHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedHotspots) ? payloadLike.resolution.removedHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedOptionalHotspots) ? payloadLike.resolution.removedOptionalHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedTopPriorityHotspots) ? payloadLike.resolution.removedTopPriorityHotspots : []),
    ...(Array.isArray(payloadLike?.changesRequiredDisplay?.removedItems) ? payloadLike.changesRequiredDisplay.removedItems : []),
  ]
    .map((row) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
    .filter((id) => Number.isFinite(id) && id > 0);

  return Array.from(new Set(ids));
}

async function postJsonViaPage(page, url, token, body) {
  const result = await page.evaluate(
    async ({ requestUrl, accessToken, payload }) => {
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        ok: response.ok,
        text: await response.text(),
      };
    },
    { requestUrl: url, accessToken: token, payload: body },
  );

  return {
    ...result,
    json: unwrapJson(result.text),
  };
}

(async () => {
  const previewPayload = loadJsonPayload(
    DEFAULT_PREVIEW_PAYLOAD,
    ['FIT_PREVIEW_PAYLOAD_FILE'],
    ['FIT_PREVIEW_PAYLOAD', 'FIT_PREVIEW_BODY'],
  );
  const confirmTemplate = loadJsonPayload(
    DEFAULT_CONFIRM_PAYLOAD,
    ['FIT_CONFIRM_PAYLOAD_FILE'],
    ['FIT_CONFIRM_PAYLOAD', 'FIT_CONFIRM_BODY'],
  );

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();

  const authResponse = await context.request.post(LOGIN_URL, {
    data: {
      email: USER_EMAIL,
      password: USER_PASSWORD,
    },
  });

  if (!authResponse.ok()) {
    throw new Error(`Login failed with status ${authResponse.status()}`);
  }

  const authData = await authResponse.json();
  const accessToken = authData?.accessToken;
  if (!accessToken) {
    throw new Error('Login succeeded but accessToken was missing');
  }

  await context.addInitScript((token) => {
    localStorage.setItem('accessToken', token);
  }, accessToken);

  const page = await context.newPage();
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/manual-hotspot/fit-preview') || url.includes('/manual-hotspot/fit-confirm')) {
      console.log('[REQ]', request.method(), url);
      console.log('[REQ][BODY]', request.postData() || '');
    }
  });
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/manual-hotspot/fit-preview') || url.includes('/manual-hotspot/fit-confirm')) {
      const text = await response.text().catch(() => '');
      console.log('[RES]', response.status(), url);
      console.log('[RES][BODY]', text.slice(0, 5000));
    }
  });

  await page.goto(ITINERARY_URL, { waitUntil: 'networkidle', timeout: 120000 });
  console.log('[PAGE]', await page.title().catch(() => ''));

  const previewResult = await postJsonViaPage(page, PREVIEW_URL, accessToken, previewPayload);
  console.log('[PREVIEW][STATUS]', previewResult.status);
  console.log('[PREVIEW][JSON]', JSON.stringify(previewResult.json, null, 2));

  const previewTravelRows = Array.isArray(previewResult.json?.finalizedTimeline)
    ? previewResult.json.finalizedTimeline.filter((row) => String(row?.type || '').toLowerCase() === 'travel')
    : [];
  if (previewTravelRows.length > 0) {
    console.log(
      '[PREVIEW][TRAVEL_ROWS]',
      JSON.stringify(
        previewTravelRows.map((row) => ({
          fromName: row?.fromName || row?.from || null,
          toName: row?.toName || row?.to || null,
          timeRange: row?.timeRange || null,
          duration: row?.duration || null,
          distance: row?.distance || null,
          matrixDurationMin: row?.matrixDurationMin ?? null,
          matrixDistanceKm: row?.matrixDistanceKm ?? null,
          hotspot_traveling_time: row?.hotspot_traveling_time || null,
          hotspot_travelling_distance: row?.hotspot_travelling_distance || null,
        })),
        null,
        2,
      ),
    );
  }

  if (DO_CONFIRM) {
    const confirmPayload = {
      ...confirmTemplate,
      attemptId: String(previewResult.json?.attemptId || confirmTemplate?.attemptId || '').trim(),
      acknowledgedRemovedHotspotIds:
        getRemovedHotspotIdsFromPayload(previewResult.json).length > 0
          ? getRemovedHotspotIdsFromPayload(previewResult.json)
          : (Array.isArray(confirmTemplate?.acknowledgedRemovedHotspotIds)
            ? confirmTemplate.acknowledgedRemovedHotspotIds
            : []),
    };

    const confirmResult = await postJsonViaPage(page, CONFIRM_URL, accessToken, confirmPayload);
    console.log('[CONFIRM][STATUS]', confirmResult.status);
    console.log('[CONFIRM][JSON]', JSON.stringify(confirmResult.json, null, 2));
  }

  await browser.close();

  if (!(previewResult.status >= 200 && previewResult.status < 300)) {
    process.exitCode = 1;
  }
})();

