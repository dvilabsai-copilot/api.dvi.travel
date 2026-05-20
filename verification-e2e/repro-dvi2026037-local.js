const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4006/api/v1';

function getTokenFromTriggerFile() {
  const triggerPath = path.join(__dirname, '..', 'trigger_optimization.js');
  const text = fs.readFileSync(triggerPath, 'utf8');
  const match = text.match(/const token\s*=\s*'([^']+)'/);
  if (!match) {
    throw new Error('Token not found in trigger_optimization.js');
  }
  return match[1];
}

function summarizeMaduraiRows(hotels) {
  const rows = Array.isArray(hotels) ? hotels : [];
  const maduraiRows = rows.filter((h) => String(h.destination || '').toLowerCase().includes('madurai'));
  const maduraiNoHotelRows = maduraiRows.filter((h) => String(h.hotelName || '').toLowerCase() === 'no hotels available');
  const maduraiRealRows = maduraiRows.filter(
    (h) => Number(h.hotelId || 0) > 0 && String(h.hotelName || '').toLowerCase() !== 'no hotels available',
  );

  return {
    totalRows: rows.length,
    maduraiRows: maduraiRows.length,
    maduraiNoHotelRows: maduraiNoHotelRows.length,
    maduraiRealRows: maduraiRealRows.length,
    sampleMaduraiRows: maduraiRows.slice(0, 8),
  };
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

async function main() {
  const token = getTokenFromTriggerFile();
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  const itineraryPayload = {
    plan: {
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: 'Chennai Central',
      departure_point: 'Pondicherry',
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: '2026-03-16T08:00:00+05:30',
      trip_end_date: '2026-03-18T20:00:00+05:30',
      pick_up_date_and_time: '2026-03-16T12:00:00+05:30',
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 2,
      no_of_days: 3,
      budget: 20000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: 'Local repro for DVI2026037 Madurai hotel validation',
    },
    routes: [
      {
        location_name: 'Chennai Central',
        next_visiting_location: 'Madurai',
        itinerary_route_date: '2026-03-16T00:00:00+05:30',
        no_of_days: 1,
        no_of_km: '',
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Madurai',
        next_visiting_location: 'Madurai',
        itinerary_route_date: '2026-03-17T00:00:00+05:30',
        no_of_days: 2,
        no_of_km: '',
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Madurai',
        next_visiting_location: 'Pondicherry',
        itinerary_route_date: '2026-03-18T00:00:00+05:30',
        no_of_days: 3,
        no_of_km: '',
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
    ],
    vehicles: [
      { vehicle_type_id: 1, vehicle_count: 1 },
    ],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };

  const createResp = await callApi(`${API_BASE}/itineraries`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(itineraryPayload),
  });

  const quoteId = createResp.body?.quoteId || createResp.body?.data?.quoteId || createResp.body?.quote_id;
  if (!quoteId) {
    const failOut = {
      createStatus: createResp.status,
      createBody: createResp.body,
      error: 'Quote ID not returned from itinerary creation',
      timestamp: new Date().toISOString(),
    };

    const outDir = path.join(__dirname, 'tbo-live-20260316');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'repro-dvi2026037-local-failed.json');
    fs.writeFileSync(outFile, JSON.stringify(failOut, null, 2));
    console.log(JSON.stringify(failOut, null, 2));
    console.log(`ARTIFACT ${outFile}`);
    process.exit(1);
  }

  const detailsResp = await callApi(`${API_BASE}/itineraries/details/${encodeURIComponent(quoteId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  const hotelDetailsResp = await callApi(`${API_BASE}/itineraries/hotel_details/${encodeURIComponent(quoteId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  const hotels = hotelDetailsResp.body?.hotels || hotelDetailsResp.body?.data?.hotels || [];
  const rowSummary = summarizeMaduraiRows(hotels);

  const result = {
    source: 'local repro for DVI2026037 pattern',
    apiBase: API_BASE,
    createdQuoteId: quoteId,
    createStatus: createResp.status,
    detailsStatus: detailsResp.status,
    hotelDetailsStatus: hotelDetailsResp.status,
    rowSummary,
    hotelTabs: hotelDetailsResp.body?.hotelTabs || [],
    inferred: rowSummary.maduraiRealRows > 0
      ? 'Madurai hotels are coming in local repro.'
      : 'Madurai hotels are still placeholders in local repro.',
    timestamp: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, 'tbo-live-20260316');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `repro-dvi2026037-local-${quoteId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(JSON.stringify(result, null, 2));
  console.log(`ARTIFACT ${outFile}`);
}

main().catch((err) => {
  console.error('FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
