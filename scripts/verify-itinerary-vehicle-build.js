const fs = require('fs');
const path = require('path');

function normalizeBaseUrl(value) {
  return String(value || 'http://127.0.0.1:4006').trim().replace(/\/+$/, '');
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolvePayload() {
  const payloadFile = String(process.env.PAYLOAD_FILE || '').trim();
  if (payloadFile) {
    const resolved = path.resolve(payloadFile);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  const payloadJson = String(process.env.PAYLOAD_JSON || '').trim();
  if (payloadJson) {
    return JSON.parse(payloadJson);
  }

  return {
    plan: {
      itinerary_plan_id: 9629,
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: 'Cochin International Airport',
      departure_point: 'Cochin International Airport',
      itinerary_preference: 2,
      itinerary_type: 2,
      preferred_hotel_category: [],
      hotel_facilities: [],
      trip_start_date: '2026-06-17T08:00:00+05:30',
      trip_end_date: '2026-06-24T20:00:00+05:30',
      pick_up_date_and_time: '2026-06-17T08:00:00+05:30',
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 7,
      no_of_days: 8,
      budget: 15000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      meal_plan_breakfast: 0,
      meal_plan_lunch: 0,
      meal_plan_dinner: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: '',
    },
    routes: [
      {
        location_name: 'Cochin International Airport',
        next_visiting_location: 'Cochin',
        itinerary_route_date: '2026-06-17T00:00:00+05:30',
        no_of_days: 1,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Cochin',
        next_visiting_location: 'Munnar',
        itinerary_route_date: '2026-06-18T00:00:00+05:30',
        no_of_days: 2,
        no_of_km: 124,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [
          {
            itinerary_via_location_ID: 63,
            itinerary_via_location_name: 'Athirappilly Water Falls, Pariyaram, Kerala',
          },
        ],
      },
      {
        location_name: 'Munnar',
        next_visiting_location: 'Munnar',
        itinerary_route_date: '2026-06-19T00:00:00+05:30',
        no_of_days: 3,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Munnar',
        next_visiting_location: 'Thekkady',
        itinerary_route_date: '2026-06-20T00:00:00+05:30',
        no_of_days: 4,
        no_of_km: 97.1,
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Thekkady',
        next_visiting_location: 'Alleppey',
        itinerary_route_date: '2026-06-21T00:00:00+05:30',
        no_of_days: 5,
        no_of_km: 138,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Alleppey',
        next_visiting_location: 'Kumarakom, Kerala, India',
        itinerary_route_date: '2026-06-22T00:00:00+05:30',
        no_of_days: 6,
        no_of_km: 32.7,
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Kumarakom, Kerala, India',
        next_visiting_location: 'Kumarakom, Kerala, India',
        itinerary_route_date: '2026-06-23T00:00:00+05:30',
        no_of_days: 7,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Kumarakom, Kerala, India',
        next_visiting_location: 'Cochin International Airport',
        itinerary_route_date: '2026-06-24T00:00:00+05:30',
        no_of_days: 8,
        no_of_km: 50.1,
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
    ],
    vehicles: [
      { vehicle_type_id: 1, vehicle_count: 1 },
      { vehicle_type_id: 23, vehicle_count: 1 },
      { vehicle_type_id: 20, vehicle_count: 1 },
      { vehicle_type_id: 21, vehicle_count: 1 },
    ],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

function hasUsableVehicleRows(details) {
  const vehicles = Array.isArray(details && details.vehicles) ? details.vehicles : [];
  if (!vehicles.length) {
    return false;
  }

  return vehicles.some((vehicle) => {
    const vendorEligibleId = Number(vehicle && vehicle.vendorEligibleId ? vehicle.vendorEligibleId : 0);
    const vehicleTypeId = Number(vehicle && vehicle.vehicleTypeId ? vehicle.vehicleTypeId : 0);
    const totalAmount = Number(vehicle && vehicle.totalAmount);
    const vendorName = String((vehicle && vehicle.vendorName) || '').trim();
    const vehicleOrigin = String((vehicle && vehicle.vehicleOrigin) || '').trim();

    return (
      vendorEligibleId > 0 &&
      vehicleTypeId > 0 &&
      Number.isFinite(totalAmount) &&
      (vendorName.length > 0 || vehicleOrigin.length > 0)
    );
  });
}

async function apiRequest(url, options) {
  const startedAt = Date.now();
  const response = await fetch(url, options);
  const text = await response.text();
  const durationMs = Date.now() - startedAt;
  const json = parseJsonSafe(text);
  return {
    ok: response.ok,
    status: response.status,
    durationMs,
    text,
    json,
  };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
}

async function main() {
  const token = String(process.env.BEARER_TOKEN || process.env.REGRESSION_BEARER_TOKEN || '').trim();
  if (!token) {
    throw new Error('Missing BEARER_TOKEN or REGRESSION_BEARER_TOKEN');
  }

  const baseUrl = normalizeBaseUrl(process.env.BASE_URL);
  const apiBase = `${baseUrl}/api/v1`;
  const shouldCreate = String(process.env.CREATE_ITINERARY || '').trim() === '1';

  let quoteId = String(process.env.QUOTE_ID || '').trim();
  let planId = Number(process.env.PLAN_ID || 0);

  if (shouldCreate) {
    const payload = resolvePayload();
    const createUrl = `${apiBase}/itineraries/?type=itineary_basic_info`;
    const createRes = await apiRequest(createUrl, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    });

    console.log('[create]', JSON.stringify({
      status: createRes.status,
      durationMs: createRes.durationMs,
      quoteId: createRes.json && (createRes.json.quoteId || createRes.json.data && createRes.json.data.quoteId),
      planId: createRes.json && (createRes.json.planId || createRes.json.data && createRes.json.data.planId),
    }, null, 2));

    if (!createRes.ok) {
      throw new Error(`Create itinerary failed: ${createRes.status} ${createRes.text}`);
    }

    quoteId = String(
      (createRes.json && (createRes.json.quoteId || createRes.json.data && createRes.json.data.quoteId)) || quoteId,
    ).trim();
    planId = Number(
      (createRes.json && (createRes.json.planId || createRes.json.data && createRes.json.data.planId)) || planId,
    );
  }

  if (!quoteId || !planId) {
    throw new Error('QUOTE_ID and PLAN_ID are required unless CREATE_ITINERARY=1 returns them');
  }

  const permitUrl = `${apiBase}/itineraries/${planId}/permit-build-sync`;
  const vehicleUrl = `${apiBase}/itineraries/${planId}/vehicle-build-sync`;
  const detailsUrl = `${apiBase}/itineraries/details/${encodeURIComponent(quoteId)}`;

  const permitRes = await apiRequest(permitUrl, {
    method: 'POST',
    headers: authHeaders(token),
  });

  console.log('[permit-build-sync]', JSON.stringify({
    status: permitRes.status,
    durationMs: permitRes.durationMs,
    body: permitRes.json || permitRes.text,
  }, null, 2));

  if (!permitRes.ok) {
    throw new Error(`Permit build failed: ${permitRes.status} ${permitRes.text}`);
  }

  const vehicleRes = await apiRequest(vehicleUrl, {
    method: 'POST',
    headers: authHeaders(token),
  });

  console.log('[vehicle-build-sync]', JSON.stringify({
    status: vehicleRes.status,
    durationMs: vehicleRes.durationMs,
    body: vehicleRes.json || vehicleRes.text,
  }, null, 2));

  if (!vehicleRes.ok) {
    throw new Error(`Vehicle build request failed: ${vehicleRes.status} ${vehicleRes.text}`);
  }

  const detailsRes = await apiRequest(detailsUrl, {
    method: 'GET',
    headers: authHeaders(token),
  });

  const details = detailsRes.json || {};
  const usableVehicles = hasUsableVehicleRows(details);
  const vehicleCount = Array.isArray(details.vehicles) ? details.vehicles.length : 0;

  console.log('[details]', JSON.stringify({
    status: detailsRes.status,
    durationMs: detailsRes.durationMs,
    quoteId,
    planId,
    vehicleCount,
    usableVehicles,
  }, null, 2));

  if (!detailsRes.ok) {
    throw new Error(`Details fetch failed: ${detailsRes.status} ${detailsRes.text}`);
  }

  const buildState = String(vehicleRes.json && vehicleRes.json.status || '').toUpperCase();
  if (buildState !== 'READY') {
    throw new Error(`Vehicle build did not finish READY. Received: ${vehicleRes.text}`);
  }

  if (!usableVehicles) {
    throw new Error(`Vehicle build reported READY but details still have no usable vehicles for quote ${quoteId}`);
  }

  console.log('[verify] success');
}

main().catch((error) => {
  console.error('[verify] failure:', error && error.message ? error.message : String(error));
  process.exit(1);
});
