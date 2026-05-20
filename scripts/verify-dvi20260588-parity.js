const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TOKEN = process.env.DVI_BEARER_TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzgyOTI5NjksImV4cCI6MTc3ODg5Nzc2OX0.T8O8Gx5u4tplHXM7pVxgWZIQuKgvGVAZLfxdiYP64i4';

const POST_URL = 'http://127.0.0.1:4006/api/v1/itineraries/?type=itineary_basic_info';
const GET_URL = 'http://127.0.0.1:4006/api/v1/itineraries/details/DVI20260588';

const payload = {
  plan: {
    itinerary_plan_id: 380,
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Bangalore, International Airport',
    departure_point: 'Bangalore, International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3],
    hotel_facilities: [],
    trip_start_date: '2026-05-17T08:00:00+05:30',
    trip_end_date: '2026-05-21T20:00:00+05:30',
    pick_up_date_and_time: '2026-05-17T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 4,
    no_of_days: 5,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,
    food_type: 0,
    meal_plan_code: 'EP',
    meal_plan_breakfast: 0,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 1,
    child_count: 0,
    infant_count: 0,
    special_instructions: ''
  },
  routes: [
    {
      location_name: 'Bangalore, International Airport',
      next_visiting_location: 'Coorg',
      itinerary_route_date: '2026-05-17T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 295,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Coorg',
      next_visiting_location: 'Coorg',
      itinerary_route_date: '2026-05-18T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Coorg',
      next_visiting_location: 'Ooty',
      itinerary_route_date: '2026-05-19T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 246,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Ooty',
      next_visiting_location: 'Ooty',
      itinerary_route_date: '2026-05-20T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: 10,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    },
    {
      location_name: 'Ooty',
      next_visiting_location: 'Bangalore, International Airport',
      itinerary_route_date: '2026-05-21T00:00:00+05:30',
      no_of_days: 5,
      no_of_km: 312,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: []
    }
  ],
  vehicles: [{ vehicle_type_id: 23, vehicle_count: 1 }],
  travellers: [{ room_id: 1, traveller_type: 1 }],
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false
};

function summarizeDays(body) {
  const days = Array.isArray(body?.days) ? body.days : [];
  for (const day of days) {
    const segments = Array.isArray(day.segments) ? day.segments : [];
    const attractions = segments.filter((s) => s.type === 'attraction');
    const ctaHotspots = segments.filter(
      (s) => s.type === 'hotspot' && (s.text || '').trim() === 'Click to Add Hotspot'
    );

    console.log(
      `Day ${day.dayNumber}: segments=${segments.length}, attractions=${attractions.length}, cta=${ctaHotspots.length}`
    );

    if (attractions.length > 0) {
      console.log('  Attractions:', attractions.map((a) => a.name).join(', '));
    }
  }
}

async function main() {
  try {
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    };

    const postRes = await axios.post(POST_URL, payload, { headers });
    console.log('POST status:', postRes.status);

    const getRes = await axios.get(GET_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log('GET status:', getRes.status);

    const outDir = path.join(process.cwd(), 'scripts', 'out');
    fs.mkdirSync(outDir, { recursive: true });

    fs.writeFileSync(
      path.join(outDir, 'dvi20260588_post_response.json'),
      JSON.stringify(postRes.data, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(outDir, 'dvi20260588_get_response.json'),
      JSON.stringify(getRes.data, null, 2),
      'utf8'
    );

    summarizeDays(getRes.data);
  } catch (error) {
    console.error('Verification failed:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Body:', JSON.stringify(error.response.data, null, 2));
    }
    process.exitCode = 1;
  }
}

main();
