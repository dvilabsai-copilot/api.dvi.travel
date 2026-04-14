const http = require('http');
const https = require('https');

const API_BASE_URL = process.env.PROD_API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const token = process.env.PROD_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzYwMTI5MDcsImV4cCI6MTc3NjYxNzcwN30.PHwy7Jtwy-i0sM_8P_UGILlQPwLhd4MAywdfzOYxZ0w';

if (!token) {
  console.error('Missing PROD_JWT_TOKEN environment variable.');
  process.exit(1);
}

const requestBody = {
  plan: {
    itinerary_plan_id: 268,
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Pondicherry Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [2],
    hotel_facilities: [],
    trip_start_date: '2026-04-28T12:00:00+05:30',
    trip_end_date: '2026-05-05T10:00:00+05:30',
    pick_up_date_and_time: '2026-04-28T12:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 7,
    no_of_days: 8,
    budget: 25000,
    entry_ticket_required: 1,
    guide_for_itinerary: 1,
    nationality: 101,
    food_type: 0,
    adult_count: 1,
    child_count: 0,
    infant_count: 0,
    special_instructions: 'PHP parity run for DVI2026031634 route pattern',
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Chennai',
      itinerary_route_date: '2026-04-28T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 43.45,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Chennai',
      next_visiting_location: 'Kanchipuram, Railway Station',
      itinerary_route_date: '2026-04-29T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 109.17,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Kanchipuram, Railway Station',
      next_visiting_location: 'Mahabalipuram',
      itinerary_route_date: '2026-04-30T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 97.81,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mahabalipuram',
      next_visiting_location: 'Mahabalipuram',
      itinerary_route_date: '2026-05-01T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: 73.86,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mahabalipuram',
      next_visiting_location: 'Udupi, Karnataka, India',
      itinerary_route_date: '2026-05-02T00:00:00+05:30',
      no_of_days: 5,
      no_of_km: 929.62,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Udupi, Karnataka, India',
      next_visiting_location: 'Mysore',
      itinerary_route_date: '2026-05-03T00:00:00+05:30',
      no_of_days: 6,
      no_of_km: 360.67,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mysore',
      next_visiting_location: 'Ooty',
      itinerary_route_date: '2026-05-04T00:00:00+05:30',
      no_of_days: 7,
      no_of_km: 173.37,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Ooty',
      next_visiting_location: 'Pondicherry Airport',
      itinerary_route_date: '2026-05-05T00:00:00+05:30',
      no_of_days: 8,
      no_of_km: 517.90,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
  ],
  vehicles: [
    {
      vehicle_type_id: 1,
      vehicle_count: 1,
    },
  ],
  travellers: [
    {
      room_id: 1,
      traveller_type: 1,
    },
  ],
};

const postData = JSON.stringify(requestBody);
const url = new URL(`${API_BASE_URL}/itineraries`);
const client = url.protocol === 'https:' ? https : http;

const options = {
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: `${url.pathname}${url.search || ''}`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(postData),
  },
};

console.log('\n=== TRIGGERING PRODUCTION OPTIMIZATION ===');
console.log(`POST ${API_BASE_URL}/itineraries\n`);

const req = client.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
      if (parsed && parsed.quoteId) {
        console.log(`\nCreated quoteId: ${parsed.quoteId}`);
      }
    } catch (err) {
      console.log(data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
  process.exit(1);
});

req.write(postData);
req.end();
