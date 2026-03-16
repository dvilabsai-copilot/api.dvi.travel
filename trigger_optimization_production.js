const https = require('https');

const API_BASE_URL = process.env.PROD_API_BASE_URL || 'https://dvi.travel/api/v1';
const token = process.env.PROD_JWT_TOKEN || '';

if (!token) {
  console.error('Missing PROD_JWT_TOKEN environment variable.');
  process.exit(1);
}

const requestBody = {
  plan: {
    itinerary_plan_id: 4,
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Chennai International Airport',
    departure_point: 'Chennai International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [2],
    hotel_facilities: [],
    trip_start_date: '2026-04-26T08:00:00+05:30',
    trip_end_date: '2026-04-30T12:00:00+05:30',
    pick_up_date_and_time: '2026-04-26T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 4,
    no_of_days: 5,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,
    food_type: 0,
    adult_count: 2,
    child_count: 0,
    infant_count: 0,
    special_instructions: '',
  },
  routes: [
    {
      location_name: 'Chennai International Airport',
      next_visiting_location: 'Mahabalipuram',
      itinerary_route_date: '2026-04-26T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Mahabalipuram',
      next_visiting_location: 'Thanjavur',
      itinerary_route_date: '2026-04-27T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Thanjavur',
      next_visiting_location: 'Madurai',
      itinerary_route_date: '2026-04-28T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Madurai',
      next_visiting_location: 'Rameswaram',
      itinerary_route_date: '2026-04-29T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Rameswaram',
      next_visiting_location: 'Madurai Airport',
      itinerary_route_date: '2026-04-30T00:00:00+05:30',
      no_of_days: 5,
      no_of_km: '',
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
  ],
  vehicles: [
    {
      vehicle_type_id: 20,
      vehicle_count: 1,
    },
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
    {
      room_id: 1,
      traveller_type: 1,
    },
  ],
};

const postData = JSON.stringify(requestBody);
const url = new URL(`${API_BASE_URL}/itineraries`);

const options = {
  hostname: url.hostname,
  port: url.port || 443,
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

const req = https.request(options, (res) => {
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
