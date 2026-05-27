/**
 * Script: Rebuild route 4648 (Day 3 Munnar → Alleppey) for plan 381
 * 
 * This triggers the itinerary rebuild endpoint which will:
 * 1. Delete existing hotspot rows for route 4648
 * 2. Re-run the timeline builder with all the stability fixes
 * 3. Re-validate the route timeline
 * 
 * Usage: node rebuild-route-4648.js
 */

const http = require('http');

const QUOTE_ID = 'DVI20260589';
const PLAN_ID = 381;
const ROUTE_ID = 4648;

const API_URL = 'http://127.0.0.1:4006/api/v1/itineraries/?type=itineary_basic_info';
const AUTH_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzk1NTA0MjgsImV4cCI6MTc4MDE1NTIyOH0.JpLZDctwv_ByjQz0owKkPH_bpqILp7fSQbqNhjHJdU4';

const payload = {
  plan: {
    itinerary_plan_id: PLAN_ID,
    agent_id: 8,
    staff_id: 0,
    location_id: 0,
    arrival_point: 'Cochin International Airport',
    departure_point: 'Cochin International Airport',
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [3, 4],
    hotel_facilities: [],
    trip_start_date: '2026-05-27T08:00:00+05:30',
    trip_end_date: '2026-05-30T20:00:00+05:30',
    pick_up_date_and_time: '2026-05-27T08:00:00+05:30',
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 3,
    no_of_days: 4,
    budget: 25000,
    entry_ticket_required: 1,
    guide_for_itinerary: 1,
    nationality: 101,
    food_type: 0,
    meal_plan_code: 'EP',
    meal_plan_breakfast: 0,
    meal_plan_lunch: 0,
    meal_plan_dinner: 0,
    adult_count: 1,
    child_count: 0,
    infant_count: 0,
    special_instructions: `Playwright manual rebuild route ${ROUTE_ID} for Day 3 stability fix ${Date.now()}`,
  },
  routes: [
    {
      location_name: 'Cochin International Airport',
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-05-27T00:00:00+05:30',
      no_of_days: 1,
      no_of_km: 73.48,
      direct_to_next_visiting_place: 1,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Munnar',
      itinerary_route_date: '2026-05-28T00:00:00+05:30',
      no_of_days: 2,
      no_of_km: 1,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Munnar',
      next_visiting_location: 'Alleppey',
      itinerary_route_date: '2026-05-29T00:00:00+05:30',
      no_of_days: 3,
      no_of_km: 159,
      direct_to_next_visiting_place: 0,
      via_route: '',
      via_routes: [],
    },
    {
      location_name: 'Alleppey',
      next_visiting_location: 'Cochin International Airport',
      itinerary_route_date: '2026-05-30T00:00:00+05:30',
      no_of_days: 4,
      no_of_km: 105.58,
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
  previousDayBillingDecisionProvided: false,
  previousDayBillingConfirmed: false,
};

function sendRequest() {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH_TOKEN,
        'Accept': '*/*',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log(`\n✅ Response Status: ${res.statusCode}`);
        console.log(`✅ Response Headers: ${JSON.stringify(res.headers, null, 2)}`);
        if (data) {
          try {
            const parsed = JSON.parse(data);
            console.log(`✅ Response Body:\n${JSON.stringify(parsed, null, 2)}`);
          } catch (e) {
            console.log(`✅ Response Body:\n${data}`);
          }
        }
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', (e) => {
      console.error(`❌ Request error: ${e.message}`);
      reject(e);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

console.log('🔄 Rebuilding route 4648 (Day 3: Munnar → Alleppey) for plan 381');
console.log(`📋 Quote ID: ${QUOTE_ID}`);
console.log(`📋 Plan ID: ${PLAN_ID}`);
console.log(`📋 Route ID: ${ROUTE_ID}`);
console.log(`📍 API: ${API_URL}`);
console.log(`⏱️  Sending rebuild request...`);

sendRequest()
  .then((result) => {
    console.log('\n✅ Rebuild request completed successfully!');
    console.log(`\n⏭️  Next: Run verify-day3-details.js to check the fixed timeline\n`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Rebuild request failed:', err.message);
    process.exit(1);
  });
