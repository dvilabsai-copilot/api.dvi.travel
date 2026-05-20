const axios = require('axios');
const fs = require('fs');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzg5NDU0MzYsImV4cCI6MTc3OTU1MDIzNn0.7HJc7NRpVEV8H9J0C8qI1Psue2_Ex40--OBZAk8Oo_g';

async function testWithAllowPriorityRemoval() {
  try {
    console.log('🧪 Testing Pothamedu WITH allowTopPriorityRemoval: true\n');
    
    const payload = {
      routeId: 4320,
      hotspotId: 219,
      anchorType: 'after_travel',
      anchorIndex: 0,
      allowTopPriorityRemoval: true,  // CHANGED: Allow removal of top-priority
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

    const data = response.data;
    
    if (data.resolution && data.resolution.slotInsights && Array.isArray(data.resolution.slotInsights)) {
      console.log(`✅ Found ${data.resolution.slotInsights.length} slot insights:\n`);
      
      data.resolution.slotInsights.forEach((slot, idx) => {
        const feasible = slot.fitsOverall ? '✅ FITS' : '❌ DOESN\'T FIT';
        console.log(`\n[SLOT ${idx + 1}] ${feasible}`);
        console.log(`  ${slot.fromName} → ${slot.toName}`);
        console.log(`  Direct: ${slot.directKm}km, Via: ${slot.viaKm}km, Extra: ${slot.distanceDelta}km`);
        console.log(`  Timing: ${slot.fitsTiming}, Overall: ${slot.fitsOverall}`);
        if (slot.reason) console.log(`  Reason: ${slot.reason}`);
      });

      // ANALYSIS
      console.log('\n\n🗺️  GEOGRAPHIC FEASIBILITY ANALYSIS:');
      console.log('════════════════════════════════════════════════════════════');
      
      const eravikulamMunnarSlot = data.resolution.slotInsights.find(s => 
        s.fromName.includes('Eravikulam') && s.toName.includes('Munnar')
      );
      
      if (eravikulamMunnarSlot) {
        console.log('\n⚠️  PROBLEM SLOT: Eravikulam → Munnar Rose Garden');
        console.log(`    Direct: ${eravikulamMunnarSlot.directKm}km`);
        console.log(`    Via Pothamedu: ${eravikulamMunnarSlot.viaKm}km`);
        console.log(`    Extra distance: ${eravikulamMunnarSlot.distanceDelta}km`);
        console.log(`    Fits Overall: ${eravikulamMunnarSlot.fitsOverall}`);
        
        if (eravikulamMunnarSlot.fitsOverall && eravikulamMunnarSlot.distanceDelta <= 0.5) {
          console.log('\n    ❌ BUG CONFIRMED: Marked as feasible with ≤0.5km extra!');
          console.log('       Pothamedu is SOUTH of Munnar - NOT on direct path!');
        } else if (eravikulamMunnarSlot.fitsOverall) {
          console.log('\n    ❌ BUG: Marked as feasible even with extra distance!');
        } else {
          console.log('\n    ✅ CORRECT: Marked as infeasible (as it should be)');
        }
      }

      // Save for analysis
      fs.writeFileSync(
        'pothamedu-with-priority-removal.json',
        JSON.stringify(data.resolution.slotInsights, null, 2)
      );
      console.log('\n\n💾 Full slot insights saved to: pothamedu-with-priority-removal.json');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

testWithAllowPriorityRemoval();
