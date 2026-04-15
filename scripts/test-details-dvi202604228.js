const API_BASE = 'http://127.0.0.1:4006/api/v1';
const TOKEN = process.env.ITINERARY_BEARER_TOKEN || '';
const QUOTE_ID = 'DVI202604228';

async function getDetails(auth) {
  const headers = auth
    ? { Authorization: `Bearer ${TOKEN}` }
    : {};

  const res = await fetch(`${API_BASE}/itineraries/details/${QUOTE_ID}`, {
    method: 'GET',
    headers,
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const days = Array.isArray(payload?.days) ? payload.days : [];
  const day1 = days.find((d) => Number(d?.dayNumber) === 1) || days[0] || null;
  const day1Segments = Array.isArray(day1?.segments) ? day1.segments : [];

  return {
    status: res.status,
    ok: res.ok,
    hasAuth: auth,
    topLevelKeys: body && typeof body === 'object' ? Object.keys(body) : null,
    success: body?.success,
    message: body?.message,
    quoteId: payload?.quoteId ?? null,
    planId: payload?.planId ?? null,
    dayCount: days.length,
    day1Id: day1?.id ?? null,
    day1Start: day1?.startTime ?? null,
    day1End: day1?.endTime ?? null,
    day1SegmentCount: day1Segments.length,
    day1FirstSegments: day1Segments.slice(0, 8),
    rawBody: body,
  };
}

(async () => {
  if (!TOKEN) {
    console.error('Missing ITINERARY_BEARER_TOKEN env var.');
    process.exit(1);
  }

  const withAuth = await getDetails(true);
  const withoutAuth = await getDetails(false);

  console.log(JSON.stringify({ withAuth, withoutAuth }, null, 2));
})();
