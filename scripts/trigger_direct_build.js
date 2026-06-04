const fs = require('fs');
const path = require('path');

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function loadPayload() {
  const payloadFile = process.env.PAYLOAD_FILE || process.env.REGRESSION_PAYLOAD_FILE || '';
  if (payloadFile) {
    const resolved = path.resolve(payloadFile);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.payload ? parsed.payload : parsed;
  }

  return {
    plan: {
      itinerary_plan_id: 422,
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: 'Cochin International Airport',
      departure_point: 'Cochin International Airport',
      itinerary_preference: 2,
      itinerary_type: 2,
      preferred_hotel_category: [],
      hotel_facilities: [],
      trip_start_date: '2026-06-14T08:00:00+05:30',
      trip_end_date: '2026-06-21T20:00:00+05:30',
      pick_up_date_and_time: '2026-06-14T08:00:00+05:30',
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 7,
      no_of_days: 8,
      budget: 15000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      meal_plan_code: 'CP',
      meal_plan_breakfast: 1,
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
        itinerary_route_date: '2026-06-14T00:00:00+05:30',
        no_of_days: 1,
        no_of_km: 29.83,
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Cochin',
        next_visiting_location: 'Munnar',
        itinerary_route_date: '2026-06-15T00:00:00+05:30',
        no_of_days: 2,
        no_of_km: 1,
        direct_to_next_visiting_place: 1,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Munnar',
        next_visiting_location: 'Munnar',
        itinerary_route_date: '2026-06-16T00:00:00+05:30',
        no_of_days: 3,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Munnar',
        next_visiting_location: 'Thekkady',
        itinerary_route_date: '2026-06-17T00:00:00+05:30',
        no_of_days: 4,
        no_of_km: 97.1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Thekkady',
        next_visiting_location: 'Alleppey',
        itinerary_route_date: '2026-06-18T00:00:00+05:30',
        no_of_days: 5,
        no_of_km: 138,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Alleppey',
        next_visiting_location: 'Kumarakom, Kerala, India',
        itinerary_route_date: '2026-06-19T00:00:00+05:30',
        no_of_days: 6,
        no_of_km: 32.7,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Kumarakom, Kerala, India',
        next_visiting_location: 'Kumarakom, Kerala, India',
        itinerary_route_date: '2026-06-20T00:00:00+05:30',
        no_of_days: 7,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
      {
        location_name: 'Kumarakom, Kerala, India',
        next_visiting_location: 'Cochin International Airport',
        itinerary_route_date: '2026-06-21T00:00:00+05:30',
        no_of_days: 8,
        no_of_km: 61.47,
        direct_to_next_visiting_place: 0,
        via_route: '',
        via_routes: [],
      },
    ],
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [{ room_id: 1, traveller_type: 1 }],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL) || 'http://127.0.0.1:4006';
  const apiBase = `${baseUrl}/api/v1`;
  const token = String(process.env.REGRESSION_BEARER_TOKEN || '').trim();
  if (!token) {
    console.error('Missing REGRESSION_BEARER_TOKEN');
    process.exit(1);
  }

  const payload = loadPayload();
  const resultFile = process.env.RESULT_FILE || process.env.REGRESSION_RESULT_FILE || '';
  const url = `${apiBase}/itineraries/?type=itineary_basic_info`;

  console.log('[TRIGGER_DIRECT_BUILD] URL', url);

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
    console.error('[TRIGGER_DIRECT_BUILD] Request failed:', err?.message || String(err));
    if (resultFile) {
      try {
        fs.writeFileSync(path.resolve(resultFile), JSON.stringify({ error: err?.message || String(err) }, null, 2), 'utf8');
      } catch {
        // ignore write errors on request failure
      }
    }
    process.exit(1);
  }

  console.log('[TRIGGER_DIRECT_BUILD] status', response.status);

  const parsed = safeJsonParse(text);
  if (resultFile) {
    try {
      fs.writeFileSync(path.resolve(resultFile), text, 'utf8');
    } catch (writeErr) {
      console.error('[TRIGGER_DIRECT_BUILD] Failed to write result file:', writeErr.message);
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
  console.log('[TRIGGER_DIRECT_BUILD] response summary', responseSummary);

  const hasExpectedIdentifiers =
    responseSummary.quoteId != null &&
    responseSummary.planId != null &&
    (responseSummary.successMarker != null || response.ok);

  if (!response.ok) {
    console.error('[TRIGGER_DIRECT_BUILD] Non-2xx build response');
    process.exit(1);
  }

  if (!parsed || !hasExpectedIdentifiers) {
    console.error('[TRIGGER_DIRECT_BUILD] Missing expected response fields or invalid JSON');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[TRIGGER_DIRECT_BUILD] Unhandled failure:', err?.stack || err?.message || String(err));
  process.exit(1);
});
