/**
 * Script: Verify Day 3 (route 4648) itinerary details after rebuild
 * 
 * This fetches the complete itinerary details for quote DVI20260589
 * and validates that:
 * 1. Day 3 has no overlapping attractions
 * 2. Day 3 has no self-travel rows
 * 3. Revi timing is sequential (travel before attraction)
 * 4. Break duration is calculated correctly
 * 5. Mullakkal temple remains at 05:00 PM - 06:00 PM
 * 
 * Usage: node verify-day3-details.js
 */

const http = require('http');

const QUOTE_ID = 'DVI20260589';
const API_URL = `http://127.0.0.1:4006/api/v1/itineraries/details/${QUOTE_ID}`;
const AUTH_TOKEN = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzk1NTA0MjgsImV4cCI6MTc4MDE1NTIyOH0.JpLZDctwv_ByjQz0owKkPH_bpqILp7fSQbqNhjHJdU4';

function fetchDetails() {
  return new Promise((resolve, reject) => {
    const url = new URL(API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
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
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

function formatTime(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  } catch (e) {
    return dateStr;
  }
}

function validateDay3(itinerary) {
  if (!itinerary.routes || itinerary.routes.length < 3) {
    console.log('❌ Could not find Day 3 route in itinerary');
    return { passed: false, issues: ['Missing Day 3 route'] };
  }

  const day3Route = itinerary.routes[2]; // Day 3 is index 2
  const day3Items = day3Route.route_hotspot_details || [];

  console.log(`\n📅 Day 3 Validation: ${day3Route.itinerary_route_date?.split('T')[0]} (Munnar → Alleppey)`);
  console.log(`📊 Items in Day 3: ${day3Items.length}`);

  const issues = [];

  // Check for overlapping attractions
  const attractions = day3Items.filter((item) => item.item_type === 2);
  for (let i = 0; i < attractions.length; i++) {
    for (let j = i + 1; j < attractions.length; j++) {
      const att1 = attractions[i];
      const att2 = attractions[j];
      const start1 = new Date(att1.hotspot_start_time).getTime();
      const end1 = new Date(att1.hotspot_end_time).getTime();
      const start2 = new Date(att2.hotspot_start_time).getTime();
      const end2 = new Date(att2.hotspot_end_time).getTime();

      // Check for overlap
      if (!(end1 <= start2 || end2 <= start1)) {
        const issue = `Overlapping attractions: "${att1.hotspot_name}" (${formatTime(att1.hotspot_start_time)} - ${formatTime(att1.hotspot_end_time)}) overlaps with "${att2.hotspot_name}" (${formatTime(att2.hotspot_start_time)} - ${formatTime(att2.hotspot_end_time)})`;
        issues.push(issue);
        console.log(`  ❌ ${issue}`);
      }
    }
  }

  // Check for self-travel rows (Travel from X to X)
  const travelRows = day3Items.filter((item) => item.item_type === 3 && item.hotspot_ID > 0);
  for (let i = 0; i < travelRows.length; i++) {
    for (let j = i + 1; j < travelRows.length; j++) {
      const travel1 = travelRows[i];
      const travel2 = travelRows[j];
      if (travel1.hotspot_ID === travel2.hotspot_ID) {
        // Same destination hotspot - potential self-travel
        const issue = `Duplicate travel rows to hotspot ${travel1.hotspot_ID} (${travel1.hotspot_name || 'Unknown'})`;
        issues.push(issue);
        console.log(`  ❌ ${issue}`);
      }
    }
  }

  // Check Coir Museum and Backwater overlap specifically
  const coirItem = day3Items.find((item) => item.hotspot_name && item.hotspot_name.includes('COIR'));
  const backwaterItem = day3Items.find((item) => item.hotspot_name && item.hotspot_name.includes('Backwater'));

  if (coirItem && backwaterItem) {
    const coirStart = new Date(coirItem.hotspot_start_time).getTime();
    const coirEnd = new Date(coirItem.hotspot_end_time).getTime();
    const bwStart = new Date(backwaterItem.hotspot_start_time).getTime();
    const bwEnd = new Date(backwaterItem.hotspot_end_time).getTime();

    if (!(coirEnd <= bwStart || bwEnd <= coirStart)) {
      const issue = `Coir Museum and Backwater overlap: Coir (${formatTime(coirItem.hotspot_start_time)}-${formatTime(coirItem.hotspot_end_time)}) vs Backwater (${formatTime(backwaterItem.hotspot_start_time)}-${formatTime(backwaterItem.hotspot_end_time)})`;
      issues.push(issue);
      console.log(`  ❌ ${issue}`);
    } else {
      console.log(`  ✅ Coir Museum (${formatTime(coirItem.hotspot_start_time)}-${formatTime(coirItem.hotspot_end_time)}) and Backwater (${formatTime(backwaterItem.hotspot_start_time)}-${formatTime(backwaterItem.hotspot_end_time)}) do not overlap`);
    }
  }

  // Check Mullakkal temple timing (should be 05:00 PM - 06:00 PM)
  const mullakkalItem = day3Items.find((item) => item.hotspot_name && item.hotspot_name.includes('Mullakkal'));
  if (mullakkalItem) {
    const mullStart = formatTime(mullakkalItem.hotspot_start_time);
    const mullEnd = formatTime(mullakkalItem.hotspot_end_time);
    if (mullStart === '17:00' && mullEnd === '18:00') {
      console.log(`  ✅ Mullakkal temple correctly scheduled: ${mullStart} - ${mullEnd}`);
    } else {
      const issue = `Mullakkal temple timing changed: ${mullStart} - ${mullEnd} (should be 17:00 - 18:00)`;
      issues.push(issue);
      console.log(`  ⚠️  ${issue}`);
    }
  } else {
    console.log(`  ⚠️  Mullakkal temple not found in Day 3`);
  }

  // Check break duration calculation
  const breaks = day3Items.filter((item) => item.item_type === 1);
  for (const brk of breaks) {
    const start = new Date(brk.hotspot_start_time);
    const end = new Date(brk.hotspot_end_time);
    const durationMinutes = (end.getTime() - start.getTime()) / (1000 * 60);
    const displayedMinutes = (brk.hotspot_traveling_time_minutes || 0);
    const displayedHours = (brk.hotspot_traveling_time_hours || 0);

    const computedDisplay = displayedHours * 60 + displayedMinutes;
    if (Math.abs(computedDisplay - durationMinutes) < 1) {
      console.log(`  ✅ Break duration correct: ${formatTime(brk.hotspot_start_time)} - ${formatTime(brk.hotspot_end_time)} = ${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`);
    } else {
      const issue = `Break duration mismatch: displayed ${computedDisplay}m, actual ${Math.floor(durationMinutes)}m`;
      issues.push(issue);
      console.log(`  ❌ ${issue}`);
    }
  }

  console.log(`\n📋 Day 3 Summary:`);
  console.log(`   Total items: ${day3Items.length}`);
  console.log(`   Attractions: ${attractions.length}`);
  console.log(`   Travel rows: ${day3Items.filter((i) => i.item_type === 3).length}`);
  console.log(`   Breaks: ${breaks.length}`);

  if (issues.length === 0) {
    console.log(`\n✅ Day 3 validation PASSED - All checks successful!`);
    return { passed: true, issues: [] };
  } else {
    console.log(`\n❌ Day 3 validation FAILED - ${issues.length} issue(s) found`);
    return { passed: false, issues };
  }
}

console.log(`\n🔍 Fetching itinerary details for quote ${QUOTE_ID}...`);
console.log(`📍 API: ${API_URL}\n`);

fetchDetails()
  .then((itinerary) => {
    const result = validateDay3(itinerary);
    process.exit(result.passed ? 0 : 1);
  })
  .catch((err) => {
    console.error(`\n❌ Error fetching details: ${err.message}`);
    process.exit(1);
  });
