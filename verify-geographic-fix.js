const axios = require('axios');
const fs = require('fs');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzg5NDU0MzYsImV4cCI6MTc3OTU1MDIzNn0.7HJc7NRpVEV8H9J0C8qI1Psue2_Ex40--OBZAk8Oo_g';

async function verifyGeographicFix() {
  try {
    console.log('✅ VERIFYING GEOGRAPHIC FEASIBILITY FIX\n');
    
    const payload = {
      routeId: 4320,
      hotspotId: 219,
      anchorType: 'after_travel',
      anchorIndex: 0,
      allowTopPriorityRemoval: true,
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

    const slots = response.data.resolution?.slotInsights || [];
    const report = {
      timestamp: new Date().toISOString(),
      testCase: 'Pothamedu (ID 219) insertion with geographic validation',
      totalSlots: slots.length,
      results: slots.map((s, idx) => ({
        slotNum: idx + 1,
        fromTo: `${s.fromName} -> ${s.toName}`,
        directKm: s.directKm,
        viaKm: s.viaKm,
        extraKm: s.distanceDelta,
        fitsOverall: s.fitsOverall,
        fitsTiming: s.fitsTiming,
        reason: s.reason,
        isBest: s.isBest
      })),
      summary: {
        feasibleSlots: slots.filter(s => s.fitsOverall).length,
        infeasibleSlots: slots.filter(s => !s.fitsOverall).length,
        bugFixed: slots.some(s => 
          s.fromName.includes('Eravikulam') && 
          s.toName.includes('Munnar') && 
          !s.fitsOverall
        ) ? 'YES - Eravikulam→Munnar now correctly marked as infeasible' : 'NO'
      }
    };

    // Print results
    console.log('SLOT INSIGHTS REPORT');
    console.log('====================\n');
    
    slots.forEach((s, idx) => {
      const status = s.fitsOverall ? '✅ FITS' : '❌ INFEASIBLE';
      console.log(`Slot ${idx + 1}: ${status}`);
      console.log(`  ${s.fromName} → ${s.toName}`);
      console.log(`  Distance: ${s.directKm}km (direct) vs ${s.viaKm}km (via insertion)`);
      console.log(`  Extra: ${s.distanceDelta}km | Timing: ${s.fitsTiming} | Best: ${s.isBest}`);
      if (s.reason) console.log(`  Reason: ${s.reason}`);
      console.log();
    });

    console.log('\nSUMMARY');
    console.log('=======');
    console.log(`Feasible slots: ${report.summary.feasibleSlots} of ${slots.length}`);
    console.log(`Infeasible slots: ${report.summary.infeasibleSlots} of ${slots.length}`);
    console.log(`\nBUG FIX STATUS: ${report.summary.bugFixed}\n`);

    // Verify the specific bug is fixed
    const eravikulamMunnarSlot = slots.find(s => 
      s.fromName.includes('Eravikulam') && 
      s.toName.includes('Munnar')
    );

    if (eravikulamMunnarSlot) {
      if (!eravikulamMunnarSlot.fitsOverall) {
        console.log('✅ SUCCESS: Bug is FIXED!');
        console.log('   Eravikulam → Munnar Rose Garden is now correctly marked as INFEASIBLE');
        console.log('   (Pothamedu is geographically off this route)\n');
      } else {
        console.log('❌ FAILURE: Bug still exists');
        console.log('   Eravikulam → Munnar is still marked as feasible\n');
      }
    }

    // Save full report
    fs.writeFileSync(
      'geographic-fix-verification.json',
      JSON.stringify(report, null, 2)
    );
    console.log('📁 Full report saved to: geographic-fix-verification.json');

  } catch (error) {
    console.error('Error:', error.message);
    if (error.response?.data?.message) {
      console.error('API Error:', error.response.data.message);
    }
  }
}

verifyGeographicFix();
