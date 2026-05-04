const http = require('http');

const payload = {
  plan: {
    agent_id: 126,
    staff_id: 0,
    location_id: 0,
    arrival_point: "Delhi",
    departure_point: "Delhi",
    itinerary_preference: 3,
    itinerary_type: 2,
    preferred_hotel_category: [13],
    hotel_facilities: ["24hr-business-center"],
    trip_start_date: "2026-04-21T06:00:00+05:30",
    trip_end_date: "2026-04-23T18:00:00+05:30",
    pick_up_date_and_time: "2026-04-21T06:00:00+05:30",
    arrival_type: 1,
    departure_type: 1,
    no_of_nights: 2,
    no_of_days: 3,
    budget: 15000,
    entry_ticket_required: 0,
    guide_for_itinerary: 0,
    nationality: 101,
    food_type: 1,
    adult_count: 2,
    child_count: 0,
    infant_count: 0,
    special_instructions: "Test early arrival fix"
  },
  routes: [
    {
      location_name: "Delhi",
      next_visiting_location: "Delhi",
      itinerary_route_date: "2026-04-21T00:00:00+05:30",
      route_start_time: "06:00:00",
      route_end_time: "23:59:00",
      no_of_days: 1,
      no_of_km: 0
    }
  ],
  vehicles: [],
  previousDayBillingDecisionProvided: true,
  previousDayBillingConfirmed: true
};

const bodyStr = JSON.stringify(payload);
const options = {
  hostname: '127.0.0.1',
  port: 4006,
  path: '/api/v1/itineraries',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(bodyStr),
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJpYXQiOjE3NDU0NzgxOTUsImV4cCI6MTc0NTU2NDU5NX0.placeholder'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  console.log(`\nStatus: ${res.statusCode}`);
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      console.log('\n=== CREATE RESPONSE ===');
      console.log(JSON.stringify(parsed, null, 2));
      
      if (parsed.itinerary_code) {
        console.log(`\n✓ Created itinerary: ${parsed.itinerary_code}`);
        
        // Now fetch the details to check if airport-to-hotel segment exists
        const detailsOptions = {
          hostname: '127.0.0.1',
          port: 4006,
          path: `/api/v1/itinerary-details/${parsed.itinerary_code}`,
          method: 'GET',
          headers: {
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJpYXQiOjE3NDU0NzgxOTUsImV4cCI6MTc0NTU2NDU5NX0.placeholder'
          }
        };
        
        const detailsReq = http.request(detailsOptions, (res2) => {
          let data2 = '';
          res2.on('data', (chunk) => { data2 += chunk; });
          res2.on('end', () => {
            try {
              const details = JSON.parse(data2);
              console.log('\n=== ITINERARY DETAILS ===');
              if (details.days && details.days[0]) {
                const day1 = details.days[0];
                console.log(`\nDay 1 Segments:`);
                if (day1.segments && Array.isArray(day1.segments)) {
                  day1.segments.forEach((seg, idx) => {
                    console.log(`  [${idx}] ${seg.type || 'unknown'}: ${seg.title || seg.label || ''}`);
                  });
                  
                  // Check for airport-to-hotel segment
                  const hasAirportTravel = day1.segments.some(s => 
                    s.type === 'travel' && s.title && s.title.toLowerCase().includes('airport')
                  );
                  const hasCheckin = day1.segments.some(s => s.type === 'checkin');
                  
                  console.log(`\n✓ Day 1 has airport travel segment: ${hasAirportTravel}`);
                  console.log(`✓ Day 1 has checkin: ${hasCheckin}`);
                  
                  if (hasAirportTravel && hasCheckin) {
                    console.log('\n✅ FIX VERIFIED: Airport-to-hotel segment is present on Day 1!');
                  } else {
                    console.log('\n❌ FIX FAILED: Airport-to-hotel segment missing from Day 1');
                  }
                } else {
                  console.log('No segments found');
                }
              } else {
                console.log('No Day 1 data');
              }
            } catch (e) {
              console.log('Error parsing details:', e.message);
            }
          });
        });
        detailsReq.on('error', e => console.error('Details request error:', e));
        detailsReq.end();
      }
    } catch (e) {
      console.log('Response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error);
});

console.log('Sending request to create itinerary with:');
console.log('- Arrival time: 06:00 AM (early arrival window)');
console.log('- previousDayBillingDecisionProvided: true');
console.log('- previousDayBillingConfirmed: true');

req.write(bodyStr);
req.end();
