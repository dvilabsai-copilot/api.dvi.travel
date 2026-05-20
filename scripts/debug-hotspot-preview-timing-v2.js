#!/usr/bin/env node
/**
 * Debug script v2: Manual Hotspot Preview Timing - STRICT PROOF-BASED TRACING
 * 
 * Only queries REAL schema fields.
 * Traces exact data flow from preview API to identify source of timing values.
 * 
 * Run with: node scripts/debug-hotspot-preview-timing-v2.js
 */

const fetch = require('node-fetch');

const CONFIG = {
  PLAN_ID: 268,
  ROUTE_ID: 1238,
  HOTSPOT_ID: 8,
  API_BASE_URL: 'http://localhost:3000/api',
  DB: null,
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

/**
 * Query REAL hotspot master fields only
 * Schema: hotspot_ID, hotspot_name, hotspot_duration (only relevant field)
 */
async function queryHotspotMaster(hotspotId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 [Q1] Querying hotspot master for ID ${hotspotId}...`);
  try {
    const hotspot = await CONFIG.DB.dvi_hotspot_place.findUnique({
      where: { hotspot_ID: Number(hotspotId) },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_duration: true,
        hotspot_priority: true,
      },
    });
    
    if (hotspot) {
      console.log('✅ Hotspot master found:');
      console.log(`   - Name: ${hotspot.hotspot_name}`);
      console.log(`   - Duration (raw): ${hotspot.hotspot_duration}`);
      console.log(`   - Priority: ${hotspot.hotspot_priority}`);
      
      // Parse duration
      if (hotspot.hotspot_duration) {
        const d = new Date(hotspot.hotspot_duration);
        const h = d.getUTCHours();
        const m = d.getUTCMinutes();
        const s = d.getUTCSeconds();
        console.log(`   - Duration (parsed): ${h}h ${m}m ${s}s = ${(h*3600 + m*60 + s)} seconds`);
      }
    } else {
      console.log('❌ Hotspot not found in dvi_hotspot_place');
    }
    
    return hotspot;
  } catch (e) {
    console.error('❌ Error:', e.message);
    return null;
  }
}

/**
 * Query the EXACT route configuration
 */
async function queryRoute(planId, routeId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 [Q2] Querying route ${routeId} details...`);
  try {
    const route = await CONFIG.DB.dvi_itinerary_route_details.findUnique({
      where: { itinerary_route_ID: Number(routeId) },
      select: {
        itinerary_route_ID: true,
        location_name: true,
        next_visiting_location: true,
        route_start_time: true,
        route_end_time: true,
      },
    });
    
    if (route) {
      console.log('✅ Route details found:');
      console.log(`   - Path: ${route.location_name} → ${route.next_visiting_location}`);
      
      const parseTime = (t) => {
        if (!t) return null;
        const d = new Date(t);
        const h = d.getUTCHours().toString().padStart(2, '0');
        const m = d.getUTCMinutes().toString().padStart(2, '0');
        const s = d.getUTCSeconds().toString().padStart(2, '0');
        return { raw: t, utc: `${h}:${m}:${s}`, display: `${h}:${m}` };
      };
      
      const start = parseTime(route.route_start_time);
      const end = parseTime(route.route_end_time);
      
      console.log(`   - Start: ${start?.display} (${start?.utc} UTC)`);
      console.log(`   - End: ${end?.display} (${end?.utc} UTC)`);
    } else {
      console.log('❌ Route not found');
    }
    
    return route;
  } catch (e) {
    console.error('❌ Error:', e.message);
    return null;
  }
}

/**
 * Query ALL rows in the route to understand the timeline BEFORE preview is called
 */
async function queryAllRowsInRoute(planId, routeId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 [Q3] Querying ALL timeline rows in route...`);
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
      console.log(`✅ Found ${rows.length} rows:`);
      
      const parseTime = (t) => {
        if (!t) return '---';
        const d = new Date(t);
        const h = d.getUTCHours().toString().padStart(2, '0');
        const m = d.getUTCMinutes().toString().padStart(2, '0');
        return `${h}:${m}`;
      };
      
      const typeMap = { 1: 'START', 3: 'TRAVEL', 4: 'HOTSPOT', 5: 'HOTEL_TRAVEL', 6: 'HOTEL' };
      
      rows.forEach((r, i) => {
        const type = typeMap[r.item_type] || `TYPE${r.item_type}`;
        const manual = r.hotspot_plan_own_way ? ' [MANUAL]' : '';
        const time = parseTime(r.hotspot_start_time);
        console.log(
          `   [${i+1}] Order:${r.hotspot_order} ID:${r.hotspot_ID || '---'} ${type}${manual} TIME:${time}`
        );
      });
    } else {
      console.log('⚠️  No rows found');
    }
    
    return rows;
  } catch (e) {
    console.error('❌ Error:', e.message);
    return null;
  }
}

/**
 * Query if hotspot ID 8 is already a manual addition
 */
async function queryExistingManualHotspot(planId, routeId, hotspotId) {
  if (!CONFIG.DB) return null;
  
  console.log(`\n📋 [Q4] Checking if hotspot ${hotspotId} already exists as manual...`);
  try {
    const existing = await CONFIG.DB.dvi_itinerary_route_hotspot_details.findFirst({
      where: {
        itinerary_plan_ID: Number(planId),
        itinerary_route_ID: Number(routeId),
        hotspot_ID: Number(hotspotId),
        item_type: 4,
        deleted: 0,
      },
      select: {
        route_hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
        hotspot_plan_own_way: true,
      },
    });
    
    if (existing) {
      console.log('✅ Hotspot ALREADY EXISTS as manual:');
      console.log(`   - Order: ${existing.hotspot_order}`);
      console.log(`   - Start: ${existing.hotspot_start_time}`);
      console.log(`   - End: ${existing.hotspot_end_time}`);
      console.log(`   - Manual flag: ${existing.hotspot_plan_own_way}`);
    } else {
      console.log('✅ Hotspot does NOT exist yet (fresh preview)');
    }
    
    return existing;
  } catch (e) {
    console.error('❌ Error:', e.message);
    return null;
  }
}

/**
 * Call the preview API and inspect EXACT response
 */
async function callPreviewAPI(planId, routeId, hotspotId) {
  console.log(`\n🌐 [API] Calling preview endpoint...`);
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
      console.error(`   ${text.substring(0, 300)}`);
      return null;
    }
    
    const data = await response.json();
    console.log('✅ API response received');
    
    // Find the selected hotspot in the response timeline
    const selectedHotspot = (data.fullTimeline || []).find(
      (seg) => seg.type === 'attraction' && Number(seg.locationId) === Number(hotspotId)
    );
    
    if (selectedHotspot) {
      console.log(`\n📊 [RESPONSE] Selected hotspot in fullTimeline:`);
      console.log(`   - Text: "${selectedHotspot.text}"`);
      console.log(`   - TimeRange: "${selectedHotspot.timeRange}"  ← THIS IS WHAT USER SEES`);
      console.log(`   - IsConflict: ${selectedHotspot.isConflict}`);
      if (selectedHotspot.isConflict) {
        console.log(`   - ConflictReason: ${selectedHotspot.conflictReason}`);
      }
      
      // Try to extract the times from timeRange string
      const match = selectedHotspot.timeRange.match(/(\d+):(\d+)\s(AM|PM)\s-\s(\d+):(\d+)\s(AM|PM)/);
      if (match) {
        console.log(`   - Parsed from timeRange: ${match[0]}`);
      }
    } else {
      console.log('❌ Selected hotspot NOT found in fullTimeline');
      console.log(`   fullTimeline: ${JSON.stringify(data.fullTimeline?.slice(0, 2), null, 2)}`);
    }
    
    return data;
  } catch (e) {
    console.error('❌ API Error:', e.message);
    return null;
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║   MANUAL HOTSPOT PREVIEW TIMING - STRICT PROOF-BASED TRACE        ║
╚════════════════════════════════════════════════════════════════════╝
`);

  console.log(`Test Case:`);
  console.log(`  Plan ID: ${CONFIG.PLAN_ID}`);
  console.log(`  Route ID: ${CONFIG.ROUTE_ID}`);
  console.log(`  Hotspot ID: ${CONFIG.HOTSPOT_ID}`);

  // Setup
  const hasPrisma = await setupPrisma();
  if (!hasPrisma) {
    console.warn('❌ Cannot run database queries without Prisma');
    console.warn('   Run: cd api.dvi.travel && npm install');
    process.exit(1);
  }

  try {
    // Phase 1: Query DB to understand current state
    console.log(`\n${'═'.repeat(70)}`);
    console.log('PHASE 1: Current Database State');
    console.log(`${'═'.repeat(70)}`);
    
    await queryHotspotMaster(CONFIG.HOTSPOT_ID);
    await queryRoute(CONFIG.PLAN_ID, CONFIG.ROUTE_ID);
    await queryAllRowsInRoute(CONFIG.PLAN_ID, CONFIG.ROUTE_ID);
    await queryExistingManualHotspot(CONFIG.PLAN_ID, CONFIG.ROUTE_ID, CONFIG.HOTSPOT_ID);

    // Phase 2: Call preview API
    console.log(`\n${'═'.repeat(70)}`);
    console.log('PHASE 2: Call Preview API');
    console.log(`${'═'.repeat(70)}`);
    
    const apiResponse = await callPreviewAPI(CONFIG.PLAN_ID, CONFIG.ROUTE_ID, CONFIG.HOTSPOT_ID);

    // Phase 3: Analysis
    console.log(`\n${'═'.repeat(70)}`);
    console.log('PHASE 3: Next Steps for Proof');
    console.log(`${'═'.repeat(70)}`);
    
    console.log(`\n✅ To identify the ROOT CAUSE of the timing, you need to:

1. Add backend logging to hotspot-engine.service.ts in rebuildRouteHotspots():
   - Log: lastVisitRow details (item_type, hotspot_ID, start_time, end_time)
   - Log: chosen manualStartTime value
   - Log: chosen manualEndTime value
   - Log: hotspot_duration from dvi_hotspot_place

2. Add logging to TimelineEnricher.enrich():
   - Log: input row for hotspot ID ${CONFIG.HOTSPOT_ID}
   - Log: hotspot_start_time and hotspot_end_time values
   - Log: formatted timeRange string

3. Then run preview again with backend logs visible

This will prove:
   - Is 02:43 from hotel travel row?
   - Is 02:43 from route start fallback?
   - Is 02:43 from some other calculation?
   - Why is end time == start time?
`);

  } finally {
    if (CONFIG.DB) await CONFIG.DB.$disconnect();
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
