const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Njc4ODI2NDMsImV4cCI6MTc2ODQ4NzQ0M30.XhlO5nE7-Lu4XsPB3DHRJPJqbuUzKnpLG9LAglpP19I';

const requestBody =
{
  "plan": {
    "itinerary_plan_id": 4,
    "agent_id": 126,
    "staff_id": 0,
    "location_id": 0,
    "arrival_point": "Chennai International Airport",
    "departure_point": "Chennai International Airport",
    "itinerary_preference": 3,
    "itinerary_type": 2,
    "preferred_hotel_category": [
      2
    ],
    "hotel_facilities": [],
    "trip_start_date": "2026-04-26T08:00:00+05:30",
    "trip_end_date": "2026-04-30T12:00:00+05:30",
    "pick_up_date_and_time": "2026-04-26T08:00:00+05:30",
    "arrival_type": 1,
    "departure_type": 1,
    "no_of_nights": 4,
    "no_of_days": 5,
    "budget": 15000,
    "entry_ticket_required": 0,
    "guide_for_itinerary": 0,
    "nationality": 101,
    "food_type": 0,
    "adult_count": 2,
    "child_count": 0,
    "infant_count": 0,
    "special_instructions": ""
  },
  "routes": [
    {
      "location_name": "Chennai International Airport",
      "next_visiting_location": "Mahabalipuram",
      "itinerary_route_date": "2026-04-26T00:00:00+05:30",
      "no_of_days": 1,
      "no_of_km": "",
      "direct_to_next_visiting_place": 0,
      "via_route": "",
      "via_routes": []
    },
    {
      "location_name": "Mahabalipuram",
      "next_visiting_location": "Thanjavur",
      "itinerary_route_date": "2026-04-27T00:00:00+05:30",
      "no_of_days": 2,
      "no_of_km": "",
      "direct_to_next_visiting_place": 0,
      "via_route": "",
      "via_routes": []
    },
    {
      "location_name": "Thanjavur",
      "next_visiting_location": "Madurai",
      "itinerary_route_date": "2026-04-28T00:00:00+05:30",
      "no_of_days": 3,
      "no_of_km": "",
      "direct_to_next_visiting_place": 0,
      "via_route": "",
      "via_routes": []
    },
    {
      "location_name": "Madurai",
      "next_visiting_location": "Rameswaram",
      "itinerary_route_date": "2026-04-29T00:00:00+05:30",
      "no_of_days": 4,
      "no_of_km": "",
      "direct_to_next_visiting_place": 0,
      "via_route": "",
      "via_routes": []
    },
    {
      "location_name": "Rameswaram",
      "next_visiting_location": "Madurai Airport",
      "itinerary_route_date": "2026-04-30T00:00:00+05:30",
      "no_of_days": 5,
      "no_of_km": "",
      "direct_to_next_visiting_place": 0,
      "via_route": "",
      "via_routes": []
    }
  ],
  "vehicles": [
    {
      "vehicle_type_id": 20,
      "vehicle_count": 1
    },
    {
      "vehicle_type_id": 1,
      "vehicle_count": 1
    }
  ],
  "travellers": [
    {
      "room_id": 1,
      "traveller_type": 1
    },
    {
      "room_id": 1,
      "traveller_type": 1
    }
  ]
};
console.log('\n=== TRIGGERING PLAN 5 OPTIMIZATION ===');
console.log('Sending POST request to https://dvi.travel/api/v1/itineraries\n');

const postData = JSON.stringify(requestBody);
const options = {
  hostname: '127.0.0.1',
  port: 4006,
  path: '/api/v1/itineraries',
  method: 'POST',
 headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(postData)
  }
};


const req = http.request(options, (res) => {
  console.log(`\n✅ Response Status: ${res.statusCode}\n`);
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('=== RESPONSE ===');
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log(data);
    }
    console.log('\n✅ Done! Log file should be in tmp/ directory');
    console.log('Run: node read_latest_log.js\n');
    process.exit(0);
  });
});

req.on('error', (error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});

console.log('Writing request body...');
req.write(postData);
req.end();
console.log('Request sent! Waiting for response...\n');
