const axios = require('axios');
const fs = require('fs');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzg5NDU0MzYsImV4cCI6MTc3OTU1MDIzNn0.7HJc7NRpVEV8H9J0C8qI1Psue2_Ex40--OBZAk8Oo_g';

async function testPothamedusSlotInsights() {
  try {
    console.log('🧪 Testing Pothamedu (ID 219) slot insights for all 7 positions...\n');
    
    const payload = {
      routeId: 4320,
      hotspotId: 219,
      anchorType: 'after_travel',
      anchorIndex: 0,
      allowTopPriorityRemoval: false,
      selectedHotspotIds: [219]
    };

    const response = await axios.post(
      'http://127.0.0.1:4006/api/v1/itineraries/381/manual-hotspot/preview',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Response Status:', response.status);
    console.log('📊 Response Data:\n');

    const data = response.data;
    
    if (data.allInsertionSlots && Array.isArray(data.allInsertionSlots)) {
      console.log(`\n📍 FOUND ${data.allInsertionSlots.length} INSERTION SLOTS:\n`);
      console.log('════════════════════════════════════════════════════════════════');
      
      data.allInsertionSlots.forEach((slot, idx) => {
        console.log(`\n[SLOT ${idx + 1}] Position: ${slot.position}, Index: ${slot.candidateIndex}`);
        console.log(`  From: ${slot.fromName}`);
        console.log(`  To: ${slot.toName}`);
        console.log(`  Direct: ${slot.directKm} km`);
        console.log(`  Via (with insertion): ${slot.viaKm} km`);
        console.log(`  Extra Distance: ${slot.distanceDelta} km`);
        console.log(`  Fits Timing: ${slot.fitsTiming}`);
        console.log(`  Fits Overall: ${slot.fitsOverall}`);
        console.log(`  Is Best: ${slot.isBest}`);
        if (slot.reason) console.log(`  Reason: ${slot.reason}`);
        console.log('────────────────────────────────────────────────────────────────');
      });
    }

    if (data.slotInsights && Array.isArray(data.slotInsights)) {
      console.log(`\n\n📍 ALSO FOUND ${data.slotInsights.length} SLOT INSIGHTS:\n`);
      console.log('════════════════════════════════════════════════════════════════');
      
      data.slotInsights.forEach((slot, idx) => {
        console.log(`\n[INSIGHT ${idx + 1}]`);
        console.log(`  From: ${slot.fromName}`);
        console.log(`  To: ${slot.toName}`);
        console.log(`  Direct: ${slot.directKm} km`);
        console.log(`  Via: ${slot.viaKm} km`);
        console.log(`  Extra: ${slot.distanceDelta} km`);
        console.log(`  Fits Timing: ${slot.fitsTiming}`);
        console.log(`  Fits Overall: ${slot.fitsOverall}`);
        console.log(`  Is Best: ${slot.isBest}`);
        if (slot.reason) console.log(`  Reason: ${slot.reason}`);
        console.log('────────────────────────────────────────────────────────────────');
      });
    }

    // Save full response to file for analysis
    fs.writeFileSync(
      'pothamedu-response-full.json',
      JSON.stringify(data, null, 2)
    );
    console.log('\n💾 Full response saved to: pothamedu-response-full.json');

    // Extract geographic analysis
    console.log('\n\n🗺️  GEOGRAPHIC ANALYSIS:\n');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('\nKnown Issue: Pothamedu (ID 219) appears in MULTIPLE route segments');
    console.log('as "on the way", even though it\'s geographically south of Munnar.\n');
    
    const slotList = data.slotInsights || data.allInsertionSlots || [];
    const problemSlots = slotList.filter(s => 
      (s.fromName.includes('Eravikulam') || s.toName.includes('Munnar')) && 
      s.fitsOverall
    );

    if (problemSlots.length > 0) {
      console.log(`⚠️  PROBLEMATIC SLOTS (should NOT fit geographically):\n`);
      problemSlots.forEach((slot, idx) => {
        console.log(`  ${idx + 1}. ${slot.fromName} → ${slot.toName}`);
        console.log(`     Extra: ${slot.distanceDelta} km (marked as feasible: ${slot.fitsOverall})`);
      });
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response Status:', error.response.status);
      console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testPothamedusSlotInsights();
