require('dotenv').config();

const path = require('path');
const XLSX = require('xlsx');

const API_BASE = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const EMAIL = process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.PROD_PASSWORD || 'Keerthi@2404ias';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: 'Revenue Manager Properties-3.xls',
    startDate: '2026-04-28',
  };

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file' && args[i + 1]) {
      opts.file = args[i + 1];
      i += 1;
      continue;
    }
    if (args[i] === '--startDate' && args[i + 1]) {
      opts.startDate = args[i + 1];
      i += 1;
    }
  }

  return opts;
}

function isoWithOffset(dateStr, time) {
  return `${dateStr}T${time}+05:30`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(dt.getUTCDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function getCitiesFromXls(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const seen = new Set();
  const orderedCities = [];

  for (const row of rows) {
    const propId = String(row.__EMPTY || '').trim();
    const city = String(row['Properties Details'] || '').trim();
    if (!/^\d+$/.test(propId) || !city) continue;
    const key = city.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      orderedCities.push(city);
    }
  }

  return orderedCities;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

function pickToken(body) {
  return (
    body?.access_token ||
    body?.accessToken ||
    body?.token ||
    body?.data?.access_token ||
    body?.data?.accessToken ||
    null
  );
}

function buildPayload(cities, startDate) {
  const arrivalPoint = cities[0];
  const departurePoint = cities[cities.length - 1];

  const routes = [];
  for (let i = 0; i < cities.length - 1; i += 1) {
    routes.push({
      location_name: cities[i],
      next_visiting_location: cities[i + 1],
      itinerary_route_date: isoWithOffset(addDays(startDate, i), '00:00:00'),
      no_of_days: i + 1,
      no_of_km: '',
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    });
  }

  routes.push({
    location_name: departurePoint,
    next_visiting_location: departurePoint,
    itinerary_route_date: isoWithOffset(addDays(startDate, cities.length - 1), '00:00:00'),
    no_of_days: cities.length,
    no_of_km: '',
    direct_to_next_visiting_place: 1,
    via_route: '',
    via_routes: [],
  });

  const tripEndDate = addDays(startDate, cities.length - 1);

  return {
    plan: {
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: arrivalPoint,
      departure_point: departurePoint,
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: isoWithOffset(startDate, '08:00:00'),
      trip_end_date: isoWithOffset(tripEndDate, '12:00:00'),
      pick_up_date_and_time: isoWithOffset(startDate, '08:00:00'),
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: cities.length - 1,
      no_of_days: cities.length,
      budget: 20000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 2,
      child_count: 0,
      infant_count: 0,
      special_instructions: `Triggered from Revenue Manager properties (${cities.length} cities)`,
    },
    routes,
    vehicles: [
      { vehicle_type_id: 1, vehicle_count: 1 },
    ],
    travellers: [
      { room_id: 1, traveller_type: 1 },
      { room_id: 1, traveller_type: 1 },
    ],
  };
}

async function main() {
  const { file, startDate } = parseArgs();
  const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);

  const cities = getCitiesFromXls(filePath);
  if (cities.length < 2) {
    throw new Error('Need at least 2 unique cities from XLS to build itinerary routes.');
  }

  console.log('Cities from XLS:', cities.join(' -> '));

  const login = await fetchJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  const token = pickToken(login.body);
  if (!login.ok || !token) {
    throw new Error(`Login failed (${login.status}): ${JSON.stringify(login.body)}`);
  }

  const payload = buildPayload(cities, startDate);

  const create = await fetchJson(`${API_BASE}/itineraries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  console.log('Create itinerary status:', create.status);
  console.log(JSON.stringify(create.body, null, 2));
}

main().catch((err) => {
  console.error('Trigger failed:', err.message);
  process.exit(1);
});
