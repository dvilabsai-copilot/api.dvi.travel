const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.QUOTE_ID || process.argv[2] || 'DVI2026034';

function getTokenFromTriggerFile() {
  const triggerPath = path.join(__dirname, 'trigger_optimization.js');
  const text = fs.readFileSync(triggerPath, 'utf8');
  const match = text.match(/const token\s*=\s*'([^']+)'/);
  if (!match) {
    throw new Error('Token not found in trigger_optimization.js');
  }
  return match[1];
}

function plusOneDay(yyyyMmDd) {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function callApi(url, options = {}) {
  const res = await fetch(url, options);
  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { raw };
  }
  return { status: res.status, body };
}

function summarizeHotelRows(hotels) {
  const rows = Array.isArray(hotels) ? hotels : [];
  const maduraiRows = rows.filter((h) => String(h.destination || '').toLowerCase().includes('madurai'));
  const maduraiNoHotel = maduraiRows.filter((h) => String(h.hotelName || '').toLowerCase() === 'no hotels available');
  const maduraiReal = maduraiRows.filter((h) => Number(h.hotelId || 0) > 0 && String(h.hotelName || '').toLowerCase() !== 'no hotels available');

  return {
    totalRows: rows.length,
    maduraiRows: maduraiRows.length,
    maduraiNoHotelRows: maduraiNoHotel.length,
    maduraiRealRows: maduraiReal.length,
    sampleMaduraiRows: maduraiRows.slice(0, 6),
  };
}

async function main() {
  const token = getTokenFromTriggerFile();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
  };

  const detailsUrl = `${API_BASE}/itineraries/details/${encodeURIComponent(QUOTE_ID)}`;
  const hotelDetailsUrl = `${API_BASE}/itineraries/hotel_details/${encodeURIComponent(QUOTE_ID)}`;

  const details = await callApi(detailsUrl, {
    method: 'GET',
    headers: authHeaders,
  });

  const hotelDetails = await callApi(hotelDetailsUrl, {
    method: 'GET',
    headers: authHeaders,
  });

  const days = Array.isArray(hotelDetails.body?.days)
    ? hotelDetails.body.days
    : Array.isArray(details.body?.days)
      ? details.body.days
      : [];

  const maduraiDates = Array.from(
    new Set(
      days
        .filter((d) => String(d.arrival || '').toLowerCase().includes('madurai') || String(d.departure || '').toLowerCase().includes('madurai'))
        .map((d) => String(d.date || '').slice(0, 10))
        .filter(Boolean),
    ),
  );

  const hotelRows = hotelDetails.body?.hotels || hotelDetails.body?.data?.hotels || [];
  const rowSummary = summarizeHotelRows(hotelRows);

  const maduraiSearchChecks = [];

  for (const checkInDate of maduraiDates) {
    const checkOutDate = plusOneDay(checkInDate);

    const withoutNationalityPayload = {
      cityCode: 'Madurai',
      checkInDate,
      checkOutDate,
      roomCount: 1,
      guestCount: 2,
      providers: ['tbo'],
    };

    const withNationalityPayload = {
      ...withoutNationalityPayload,
      guestNationality: 'IN',
    };

    const searchWithoutNationality = await callApi(`${API_BASE}/hotels/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(withoutNationalityPayload),
    });

    const searchWithNationality = await callApi(`${API_BASE}/hotels/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(withNationalityPayload),
    });

    maduraiSearchChecks.push({
      checkInDate,
      checkOutDate,
      withoutNationality: {
        status: searchWithoutNationality.status,
        message: searchWithoutNationality.body?.message,
        totalResults: searchWithoutNationality.body?.data?.totalResults,
      },
      withNationality: {
        status: searchWithNationality.status,
        message: searchWithNationality.body?.message,
        totalResults: searchWithNationality.body?.data?.totalResults,
        sampleHotel: searchWithNationality.body?.data?.hotels?.[0]?.hotelName || null,
      },
    });
  }

  let inferredReason = 'Could not infer a single root cause from checks.';

  const hasNationalityValidationPattern = maduraiSearchChecks.some(
    (c) => c.withoutNationality.status === 400 && String(c.withoutNationality.message || '').toLowerCase().includes('guestnationality') && c.withNationality.status === 200 && Number(c.withNationality.totalResults || 0) > 0,
  );

  if (hasNationalityValidationPattern && rowSummary.maduraiNoHotelRows > 0) {
    inferredReason = 'Likely root cause: itinerary hotel_details flow calls hotels/search without guestNationality for TBO, resulting in validation failure and fallback No Hotels Available rows for Madurai.';
  } else if (rowSummary.maduraiNoHotelRows > 0) {
    inferredReason = 'Madurai fallback rows exist, but validation pattern was not conclusively matched. Could be city mapping mismatch or provider inventory/session issue.';
  } else if (rowSummary.maduraiRealRows > 0) {
    inferredReason = 'Madurai real hotels are present in hotel_details response for this quote.';
  }

  const result = {
    quoteId: QUOTE_ID,
    apiBase: API_BASE,
    detailsStatus: details.status,
    hotelDetailsStatus: hotelDetails.status,
    rowSummary,
    maduraiDates,
    maduraiSearchChecks,
    inferredReason,
    timestamp: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, 'verification-e2e', 'tbo-live-20260316');
  const outFile = path.join(outDir, `madurai-hotel-details-debug-${QUOTE_ID}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));
  console.log(`ARTIFACT ${outFile}`);
}

main().catch((err) => {
  console.error('FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
