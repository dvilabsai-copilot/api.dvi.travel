const http = require('http');

// Step 1: Login to get a valid token
const loginPayload = JSON.stringify({
  email: 'admin@dvi.co.in',
  password: 'Admin@123'
});

const loginOptions = {
  hostname: '127.0.0.1',
  port: 4006,
  path: '/api/v1/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(loginPayload)
  }
};

console.log('Step 1: Getting auth token...');
const loginReq = http.request(loginOptions, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const loginResult = JSON.parse(data);      
      if (loginResult.accessToken) {
        const token = loginResult.accessToken;
        console.log(`✓ Got token: ${token.substring(0, 20)}...`);
        
        // Step 2: Create itinerary with token
        createItinerary(token);
      } else {
        console.log('Login failed:', loginResult);
      }
    } catch (e) {
      console.log('Login error:', e.message, 'Response:', data.substring(0, 200));
    }
  });
});

loginReq.on('error', (error) => {
  console.error('Login request error:', error);
});

loginReq.write(loginPayload);
loginReq.end();

function createItinerary(token) {
  console.log('\nStep 2: Creating itinerary with early arrival + previous-day billing decision...');
  
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
      'Authorization': `Bearer ${token}`
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    console.log(`Status: ${res.statusCode}`);
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log('\n=== CREATE RESPONSE ===');
        console.log(JSON.stringify(result, null, 2));
        
        if (result.itinerary_code) {
          const quoteId = result.itinerary_code;
          console.log(`\n✓ Created itinerary: ${quoteId}`);
          
          // Step 3: Fetch details page
          console.log('\nStep 3: Fetching itinerary details...');
          const detailsOptions = {
            hostname: '127.0.0.1',
            port: 4006,
            path: `/api/v1/itinerary-details/${quoteId}`,
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${token}`
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
                  console.log(`\nDay 1 Information:`);
                  console.log(`- Date: ${day1.date}`);
                  console.log(`- Departure: ${day1.departure}`);
                  console.log(`- Arrival: ${day1.arrival}`);
                  console.log(`\nSegments (${day1.segments ? day1.segments.length : 0} total):`);
                  
                  if (day1.segments && Array.isArray(day1.segments)) {
                    let hasAirportTravel = false;
                    let hasCheckin = false;
                    
                    day1.segments.forEach((seg, idx) => {
                      const segType = seg.type || 'unknown';
                      const segTitle = seg.title || seg.label || '';
                      console.log(`  [${idx}] ${segType}: ${segTitle}`);
                      
                      if (segType === 'travel' && (segTitle.toLowerCase().includes('airport') || segTitle.toLowerCase().includes('arrival'))) {
                        hasAirportTravel = true;
                      }
                      if (segType === 'checkin') {
                        hasCheckin = true;
                      }
                    });
                    
                    console.log(`\n=== FIX VERIFICATION ===`);
                    console.log(`✓ Has "airport/arrival to hotel" travel segment: ${hasAirportTravel}`);
                    console.log(`✓ Has hotel checkin: ${hasCheckin}`);
                    
                    if (hasAirportTravel && hasCheckin) {
                      console.log('\n✅ FIX VERIFIED: Airport-to-Hotel segment is present on Day 1!');
                      console.log('   The previous-day billing decision is being processed correctly.');
                    } else {
                      console.log('\n❌ FIX STATUS: Segments may not match expected pattern');
                      console.log('   Please verify manually at: http://localhost:8080/itinerary-details/' + quoteId);
                    }
                  }
                }
              } catch (e) {
                console.log('Error parsing details:', e.message);
                console.log('Response:', data2.substring(0, 500));
              }
            });
          });
          detailsReq.on('error', e => console.error('Details request error:', e));
          detailsReq.end();
        }
      } catch (e) {
        console.log('Response:', data.substring(0, 500));
      }
    });
  });

  req.on('error', (error) => {
    console.error('Request error:', error);
  });

  req.write(bodyStr);
  req.end();
}
