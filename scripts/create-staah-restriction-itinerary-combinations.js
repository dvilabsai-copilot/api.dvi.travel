require('dotenv').config();

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:4006';
const BUILD_PATH = '/itineraries/?type=itineary_basic_info';
const DEFAULT_EMAIL = 'admin@dvi.co.in';

const BASE_PAYLOAD = {
  plan: {
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Cochin International Airport',
    departure_point: 'Cochin International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3, 4],
    hotel_facilities: [],
    trip_start_date: '2026-06-22T08:00:00+05:30',
    trip_end_date: '2026-06-23T20:00:00+05:30',
    pick_up_date_and_time: '2026-06-22T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 1,
    no_of_days: 2,
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
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-06-22T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 73.48,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Cochin International Airport',
      itinerary_route_date: '2026-06-23T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 1,
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
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

const CASES = [
  {
    name: 'control_open',
    description: 'Future control case on an open date',
    startDate: '2026-06-21',
    endDate: '2026-06-22',
    expectedRestriction: 'none',
    mealPlanCode: 'CP',
  },
  {
    name: 'staah_cta_deluxeroom_cp',
    description: 'Arrival blocked by CTA on DELUXEROOM / CP_PLAN',
    startDate: '2026-07-24',
    endDate: '2026-07-25',
    expectedRestriction: 'cta',
    mealPlanCode: 'CP',
  },
  {
    name: 'staah_ctd_deluxeroom_cp',
    description: 'Departure blocked by CTD on DELUXEROOM / CP_PLAN',
    startDate: '2026-07-24',
    endDate: '2026-07-25',
    expectedRestriction: 'ctd',
    mealPlanCode: 'CP',
  },
  {
    name: 'staah_stopsell_deluxeroom_range',
    description: 'Multi-day stopsell on DELUXEROOM / CP_PLAN',
    startDate: '2026-07-17',
    endDate: '2026-07-18',
    expectedRestriction: 'stopsell',
    mealPlanCode: 'CP',
  },
  {
    name: 'staah_cta_suiteroom_map',
    description: 'Arrival blocked by CTA on SUITEROOM / MAP_PLAN',
    startDate: '2026-07-26',
    endDate: '2026-07-27',
    expectedRestriction: 'cta',
    mealPlanCode: 'MAP',
  },
  {
    name: 'staah_ctd_suiteroom_map',
    description: 'Departure blocked by CTD on SUITEROOM / MAP_PLAN',
    startDate: '2026-07-26',
    endDate: '2026-07-27',
    expectedRestriction: 'ctd',
    mealPlanCode: 'MAP',
  },
  {
    name: 'staah_status_close_deluxe_room_cp',
    description: 'Status Close active on DELUXE_ROOM / CP_PLAN',
    startDate: '2026-11-10',
    endDate: '2026-11-11',
    expectedRestriction: 'status_close',
    mealPlanCode: 'CP',
  },
];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--mode' && next) {
      options.mode = String(next).trim();
      index += 1;
      continue;
    }
    if (current === '--cases' && next) {
      options.cases = String(next).trim();
      index += 1;
      continue;
    }
    if (current === '--base-url' && next) {
      options.baseUrl = String(next).trim();
      index += 1;
      continue;
    }
    if (current === '--email' && next) {
      options.email = String(next).trim();
      index += 1;
      continue;
    }
    if (current === '--password' && next) {
      options.password = String(next).trim();
      index += 1;
      continue;
    }
    if (current === '--output-file' && next) {
      options.outputFile = String(next).trim();
      index += 1;
    }
  }
  return options;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function addDays(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate.toISOString().slice(0, 10);
}

function toDateTime(dateString, time) {
  return `${dateString}T${time}+05:30`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPayloadForCase(testCase) {
  const payload = clone(BASE_PAYLOAD);
  const startDate = testCase.startDate;
  const endDate = testCase.endDate || addDays(startDate, 1);
  const noOfNights = Math.max(0, dayDiff(startDate, endDate));
  const noOfDays = noOfNights + 1;
  const mealPlanCode = String(testCase.mealPlanCode || '').trim().toUpperCase();

  payload.plan.trip_start_date = toDateTime(startDate, '08:00:00');
  payload.plan.trip_end_date = toDateTime(endDate, '20:00:00');
  payload.plan.pick_up_date_and_time = toDateTime(startDate, '08:00:00');
  payload.plan.no_of_nights = noOfNights;
  payload.plan.no_of_days = noOfDays;
  payload.plan.special_instructions = `STAAH restriction testcase: ${testCase.name}`;
  payload.plan.meal_plan_code = mealPlanCode || null;
  payload.plan.meal_plan_breakfast = mealPlanCode === 'CP' || mealPlanCode === 'MAP' ? 1 : 0;
  payload.plan.meal_plan_lunch = 0;
  payload.plan.meal_plan_dinner = mealPlanCode === 'MAP' ? 1 : 0;

  payload.routes = [
    {
      location_name: 'Cochin International Airport',
      next_visiting_location: 'Munnar',
      itinerary_route_date: toDateTime(startDate, '00:00:00'),
      no_of_days: 1,
      no_of_km: 73.48,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Cochin International Airport',
      itinerary_route_date: toDateTime(endDate, '00:00:00'),
      no_of_days: noOfDays,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
  ];

  return payload;
}

function dayDiff(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function ensureToken(apiBase, cliOptions) {
  const directToken = String(
    process.env.DVI_BEARER_TOKEN ||
    process.env.REGRESSION_BEARER_TOKEN ||
    process.env.DVI_JWT_TOKEN ||
    '',
  ).trim();

  if (directToken) {
    return directToken;
  }

  const email = String(
    cliOptions.email ||
    process.env.PROD_EMAIL ||
    process.env.DVI_EMAIL ||
    DEFAULT_EMAIL,
  ).trim();
  const password = String(
    cliOptions.password ||
    process.env.PROD_PASSWORD ||
    process.env.DVI_PASSWORD ||
    'Keerthi@2404ias',
  ).trim();
  if (!password) {
    throw new Error('Missing DVI_PASSWORD');
  }

  const response = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const text = await response.text();
  const data = safeJsonParse(text);
  const token =
    data?.data?.accessToken ||
    data?.accessToken ||
    data?.token ||
    data?.data?.token ||
    null;

  if (!token) {
    throw new Error(`Unable to obtain bearer token. status=${response.status}`);
  }

  return token;
}

function getRequestedCases() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const caseFilter = String(cliOptions.cases || process.env.CASES || process.env.STAAH_CASES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (caseFilter.length === 0) {
    return CASES;
  }

  const selected = CASES.filter((testCase) => caseFilter.includes(testCase.name));
  if (selected.length === 0) {
    throw new Error(`No matching cases found for filter: ${caseFilter.join(', ')}`);
  }
  return selected;
}

function summarizeCase(testCase, payload) {
  return {
    name: testCase.name,
    description: testCase.description,
    expectedRestriction: testCase.expectedRestriction,
    tripStartDate: payload.plan.trip_start_date,
    tripEndDate: payload.plan.trip_end_date,
    routeDates: payload.routes.map((route) => route.itinerary_route_date),
    adults: payload.plan.adult_count,
    children: payload.plan.child_count,
    nights: payload.plan.no_of_nights,
  };
}

async function createItinerary(apiBase, token, testCase, payload) {
  const url = `${apiBase}${BUILD_PATH}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const data = safeJsonParse(text);

  return {
    caseName: testCase.name,
    status: response.status,
    ok: response.ok,
    quoteId: data?.quoteId || data?.data?.quoteId || data?.response?.quoteId || null,
    planId: data?.planId || data?.data?.planId || data?.response?.planId || null,
    response: data || text,
  };
}

async function main() {
  const cliOptions = parseArgs(process.argv.slice(2));
  const mode = String(cliOptions.mode || process.env.MODE || 'list').trim().toLowerCase();
  const baseUrl = normalizeBaseUrl(cliOptions.baseUrl || process.env.BASE_URL || process.env.DVI_API_BASE_URL);
  const apiBase = `${baseUrl}/api/v1`;
  const requestedCases = getRequestedCases();
  const outputFile = String(cliOptions.outputFile || process.env.OUTPUT_FILE || '').trim();

  const payloads = requestedCases.map((testCase) => {
    const payload = buildPayloadForCase(testCase);
    return {
      case: testCase,
      payload,
      summary: summarizeCase(testCase, payload),
    };
  });

  if (mode === 'list') {
    console.log(JSON.stringify(payloads.map((entry) => ({
      ...entry.summary,
      payload: entry.payload,
    })), null, 2));
    return;
  }

  if (mode !== 'run') {
    throw new Error(`Unsupported MODE=${mode}. Use MODE=list or MODE=run`);
  }

  const token = await ensureToken(apiBase, cliOptions);
  const results = [];

  for (const entry of payloads) {
    console.log(`[staah-restriction-itins] creating ${entry.case.name}`);
    console.log(JSON.stringify(entry.summary, null, 2));
    const result = await createItinerary(apiBase, token, entry.case, entry.payload);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  if (outputFile) {
    fs.writeFileSync(path.resolve(outputFile), JSON.stringify(results, null, 2), 'utf8');
    console.log(`[staah-restriction-itins] wrote ${outputFile}`);
  }
}

main().catch((error) => {
  console.error('[staah-restriction-itins] failed:', error?.stack || error?.message || String(error));
  process.exit(1);
});
