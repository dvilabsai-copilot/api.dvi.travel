const http = require('http');

const API_BASE_URL = 'http://127.0.0.1:4006/api/v1';
const token = process.env.DVI_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODAxNTUzNDQsImV4cCI6MTc4MDc2MDE0NH0.3qZPh6VNDxZvrpWTTZA3BliZKyGEGhuNgNuIAfWudu0';

const requestBody = {"plan":{"itinerary_plan_id":410,"agent_id":126,"staff_id":0,"location_id":0,"arrival_point":"Cochin International Airport","departure_point":"Cochin International Airport","itinerary_preference":2,"itinerary_type":2,"preferred_hotel_category":[],"hotel_facilities":[],"trip_start_date":"2026-06-01T08:00:00+05:30","trip_end_date":"2026-06-06T20:00:00+05:30","pick_up_date_and_time":"2026-06-01T08:00:00+05:30","arrival_type":1,"departure_type":1,"no_of_nights":5,"no_of_days":6,"budget":15000,"entry_ticket_required":0,"guide_for_itinerary":0,"nationality":101,"food_type":0,"meal_plan_code":"CP","meal_plan_breakfast":1,"meal_plan_lunch":0,"meal_plan_dinner":0,"adult_count":1,"child_count":0,"infant_count":0,"special_instructions":""},"routes":[{"location_name":"Cochin International Airport","next_visiting_location":"Cochin","itinerary_route_date":"2026-06-01T00:00:00+05:30","no_of_days":1,"no_of_km":29.83,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]},{"location_name":"Cochin","next_visiting_location":"Munnar","itinerary_route_date":"2026-06-02T00:00:00+05:30","no_of_days":2,"no_of_km":1,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]},{"location_name":"Munnar","next_visiting_location":"Munnar","itinerary_route_date":"2026-06-03T00:00:00+05:30","no_of_days":3,"no_of_km":1,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]},{"location_name":"Munnar","next_visiting_location":"Thekkady","itinerary_route_date":"2026-06-04T00:00:00+05:30","no_of_days":4,"no_of_km":97.1,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]},{"location_name":"Thekkady","next_visiting_location":"Alleppey","itinerary_route_date":"2026-06-05T00:00:00+05:30","no_of_days":5,"no_of_km":138,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]},{"location_name":"Alleppey","next_visiting_location":"Cochin International Airport","itinerary_route_date":"2026-06-06T00:00:00+05:30","no_of_days":6,"no_of_km":74.86,"direct_to_next_visiting_place":0,"via_route":"","via_routes":[]}],"vehicles":[{"vehicle_type_id":1,"vehicle_count":1}],"travellers":[{"room_id":1,"traveller_type":1}],"previousDayBillingDecisionProvided":false,"previousDayBillingConfirmed":false};

const postData = JSON.stringify(requestBody);
const url = new URL(`${API_BASE_URL}/itineraries/?type=itineary_basic_info`);

const options = {
  hostname: url.hostname,
  port: url.port || 80,
  path: `${url.pathname}${url.search}`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(postData),
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    try {
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    } catch {
      console.log(data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
  process.exit(1);
});

req.write(postData);
req.end();
