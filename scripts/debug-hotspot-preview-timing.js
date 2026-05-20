#!/usr/bin/env node
/**
 * Debug script: Manual Hotspot Preview Timing Investigation
 * 
 * Traces the exact data flow from hotspot selection → preview API response
 * to identify why the preview time shows 2:43 AM instead of the expected
 * hotspot opening hours (06:00 AM - 12:00 PM)
 * 
 * Run with: node scripts/debug-hotspot-preview-timing.js
 */

const fetch = require('node-fetch');
const path = require('path');

// Configuration
const CONFIG = {
  // Update these with actual values from your test case
  PLAN_ID: 268,
  ROUTE_ID: 1238,
  HOTSPOT_ID: 8, // "Arulmigu Sri Sthala Sayana Perumal Temple"
  HOTSPOT_NAME: 'Arulmigu Sri Sthala Sayana Perumal Temple',
  API_BASE_URL: 'http://localhost:3000/api',
  DB: null, // Will be set up after prisma import
};

async function setupPrisma() {
  try {
    const { PrismaClient } = require('@prisma/client');
    CONFIG.DB = new PrismaClient();
    return true;
  } catch (e) {
    console.warn('⚠️  Prisma not available, will skip DB queries');
    return false;
  }
}

async function queryHotspotMaster(hotspotId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 Querying hotspot master for ID ${hotspotId}...`);
  try {
    const hotspot = await CONFIG.DB.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: Number(hotspotId) },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        opening_time: true,
        closing_time: true,
        visitDuration: true,
        visitDuration_unit: true,
      },
    });
    
    if (hotspot) {
      console.log('✅ Hotspot master found:');
      console.log(`   - Name: ${hotspot.hotspot_name}`);
      console.log(`   - Opening: ${hotspot.opening_time}`);
      console.log(`   - Closing: ${hotspot.closing_time}`);
      console.log(`   - Duration: ${hotspot.visitDuration} ${hotspot.visitDuration_unit || 'min'}`);
    } else {
      console.log('❌ Hotspot not found in dvi_hotspot_place');
    }
    
    return hotspot;
  } catch (e) {
    console.error('❌ Error querying hotspot:', e.message);
    return null;
  }
}

async function queryCurrentManualHotspotRow(planId, routeId, hotspotId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 Querying current manual hotspot row in itinerary...`);
  try {
    const row = await CONFIG.DB.dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_plan_own_way: true,
        is_conflict: true,
        conflict_reason: true,
      },
    });
    
    if (row) {
      console.log('✅ Current hotspot row found in DB:');
      console.log(`   - Order: ${row.hotspot_order}`);
      console.log(`   - Start Time (raw): ${row.hotspot_start_time}`);
      console.log(`   - End Time (raw): ${row.hotspot_end_time}`);
      console.log(`   - Manual flag: ${row.hotspot_plan_own_way}`);
      console.log(`   - Is Conflict: ${row.is_conflict}`);
      if (row.is_conflict) console.log(`   - Conflict Reason: ${row.conflict_reason}`);
      
      // Parse times
      if (row.hotspot_start_time) {
        const startDate = new Date(row.hotspot_start_time);
        const hours = startDate.getUTCHours();
        const minutes = startDate.getUTCMinutes();
        const testTime = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
        console.log(`   - Parsed time (UTC): ${testTime}`);
      }
    } else {
      console.log('⚠️  No active manual hotspot row found - it may have been deleted/cleaned up');
    }
    
    return row;
  } catch (e) {
    console.error('❌ Error querying row:', e.message);
    return null;
  }
}

async function queryAllHotspotRowsInRoute(planId, routeId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 Querying ALL hotspot rows for route ${routeId}...`);
  try {
    const rows = await CONFIG.DB.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_ID: true,
        item_type: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_plan_own_way: true,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });
    
    if (rows && rows.length > 0) {
      console.log(`✅ Found ${rows.length} rows in route:`);
      rows.forEach((r, idx) => {
        const itemTypeMap = { 1: 'Start', 3: 'Travel', 4: 'Hotspot', 5: 'Hotel Travel', 6: 'Hotel' };
        const type = itemTypeMap[r.item_type] || `Type${r.item_type}`;
        const isManual = r.hotspot_plan_own_way ? ' [MANUAL]' : '';
        console.log(`\n   Row ${idx + 1}: ${type}${isManual}`);
        console.log(`      - Order: ${r.hotspot_order}`);
        console.log(`      - Hotspot ID: ${r.hotspot_ID || 'N/A'}`);
        if (r.hotspot_start_time) {
          const startDate = new Date(r.hotspot_start_time);
          const h = startDate.getUTCHours().toString().padStart(2, '0');
          const m = startDate.getUTCMinutes().toString().padStart(2, '0');
          console.log(`      - Time: ${h}:${m} (raw: ${r.hotspot_start_time})`);
        }
      });
    } else {
      console.log('⚠️  No rows found in route');
    }
    
    return rows;
  } catch (e) {
    console.error('❌ Error querying rows:', e.message);
    return null;
  }
}

async function queryRoute(planId, routeId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 Querying route details...`);
  try {
    const route = await CONFIG.DB.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: {
        itinerary_route_ID: true,
        location_name: true,
        next_visiting_location: true,
        itinerary_route_date: true,
        route_start_time: true,
        route_end_time: true,
      },
    });
    
    if (route) {
      console.log('✅ Route details found:');
      console.log(`   - Location: ${route.location_name} → ${route.next_visiting_location}`);
      console.log(`   - Date: ${route.itinerary_route_date}`);
      console.log(`   - Start Time (raw): ${route.route_start_time}`);
      console.log(`   - End Time (raw): ${route.route_end_time}`);
      
      if (route.route_start_time) {
        const startDate = new Date(route.route_start_time);
        const h = startDate.getUTCHours().toString().padStart(2, '0');
        const m = startDate.getUTCMinutes().toString().padStart(2, '0');
        console.log(`   - Start time (parsed UTC): ${h}:${m}`);
      }
    } else {
      console.log('❌ Route not found');
    }
    
    return route;
  } catch (e) {
    console.error('❌ Error querying route:', e.message);
    return null;
  }
}

async function callPreviewAPI(planId, routeId, hotspotId) {
  console.log(`\n🌐 Calling preview API...`);
  console.log(`   POST ${CONFIG.API_BASE_URL}/itineraries/${planId}/manual-hotspot/preview`);
  console.log(`   Body: { routeId: ${routeId}, hotspotId: ${hotspotId} }`);
  
  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}/itineraries/${planId}/manual-hotspot/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeId, hotspotId }),
    });
    
    if (!response.ok) {
      console.error(`❌ API returned status ${response.status}`);
      const text = await response.text();
      console.error(`   Response: ${text.substring(0, 200)}`);
      return null;
    }
    
    const data = await response.json();
    console.log('✅ Preview API response received');
    
    // Find selected hotspot in timeline
    const selectedHotspot = (data.fullTimeline || []).find(
      (seg) => seg.type === 'attraction' && Number(seg.locationId) === Number(hotspotId)
    );
    
    if (selectedHotspot) {
      console.log(`\n📊 Selected hotspot in timeline:`);
      console.log(`   - Text: ${selectedHotspot.text}`);
      console.log(`   - TimeRange: ${selectedHotspot.timeRange}`);
      console.log(`   - IsConflict: ${selectedHotspot.isConflict}`);
      if (selectedHotspot.isConflict) {
        console.log(`   - Reason: ${selectedHotspot.conflictReason}`);
      }
      
      // Print raw response for comparison
      console.log(`\n📋 Full response metadata:`);
      console.log(`   - newHotspot found: ${!!data.newHotspot}`);
      console.log(`   - fullTimeline length: ${(data.fullTimeline || []).length}`);
      console.log(`   - selectedIncluded: ${data.selectedIncluded}`);
      console.log(`   - success: ${data.success}`);
    } else {
      console.log(`⚠️  Selected hotspot NOT found in timeline (may have failed to schedule)`);
    }
    
    return data;
  } catch (e) {
    console.error('❌ Error calling API:', e.message);
    return null;
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('🔍 MANUAL HOTSPOT PREVIEW TIMING DEBUG');
  console.log('='.repeat(70));
  console.log(`\nTest parameters:`);
  console.log(`  Plan ID: ${CONFIG.PLAN_ID}`);
  console.log(`  Route ID: ${CONFIG.ROUTE_ID}`);
  console.log(`  Hotspot ID: ${CONFIG.HOTSPOT_ID} (${CONFIG.HOTSPOT_NAME})`);
  
  // Setup
  const hasPrisma = await setupPrisma();
  
  // === PHASE 1: Database State ===
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 1: Current Database State');
  console.log('='.repeat(70));
  
  const hotspotMaster = await queryHotspotMaster(CONFIG.HOTSPOT_ID);
  const route = await queryRoute(CONFIG.PLAN_ID, CONFIG.ROUTE_ID);
  const allRows = await queryAllHotspotRowsInRoute(CONFIG.PLAN_ID, CONFIG.ROUTE_ID);
  const manualRow = await queryCurrentManualHotspotRow(CONFIG.PLAN_ID, CONFIG.ROUTE_ID, CONFIG.HOTSPOT_ID);
  
  // === PHASE 2: Preview API ===
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 2: Call Preview API');
  console.log('='.repeat(70));
  
  const previewResponse = await callPreviewAPI(CONFIG.PLAN_ID, CONFIG.ROUTE_ID, CONFIG.HOTSPOT_ID);
  
  // === PHASE 3: Analysis ===
  console.log('\n' + '='.repeat(70));
  console.log('PHASE 3: Root Cause Analysis');
  console.log('='.repeat(70));
  
  console.log(`\n✅ Investigation complete. Review the output above.`);
  console.log(`\nKey things to check:`);
  console.log(`  1. Is hotspotMaster opening_time = "06:00" and closing_time = "12:00"?`);
  console.log(`  2. What is the current hotspot_start_time in the row?`);
  console.log(`  3. Does it match a route_start_time or some other calculated value?`);
  console.log(`  4. Is the preview response using the correct field for timeRange?`);
  
  if (CONFIG.DB) {
    await CONFIG.DB.$disconnect();
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
