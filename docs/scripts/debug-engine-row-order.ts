/**
 * Debug script: Verify engine writes rows in correct chronological order
 * Test quote: DVI202604230 (Day 2 has known ordering issues)
 * 
 * Expected results AFTER fix:
 * 1. Rows ordered chronologically by hotspot_start_time
 * 2. No DROP_OFF (item_type=7) exceeding route_end_time
 * 3. Hotel travel (5) before checkin (6), with correct arrival anchoring
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const planId = 268; // DVI202604230
  
  console.log('\n=== ENGINE ROW ORDER VERIFICATION ===\n');
  console.log(`Testing plan ID: ${planId}\n`);
  
  // Get all routes for this plan
  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: planId },
    orderBy: { itinerary_route_ID: 'asc' },
    select: {
      itinerary_route_ID: true,
      route_number: true,
      route_start_time: true,
      route_end_time: true,
    },
  });
  
  console.log(`Found ${routes.length} routes:\n`);
  
  for (const route of routes) {
    console.log(`\n--- ROUTE ${route.route_number} (ID: ${route.itinerary_route_ID}) ---`);
    console.log(`Route times: ${new Date(route.route_start_time).toISOString()} to ${new Date(route.route_end_time).toISOString()}`);
    
    // Get all hotspot details for this route, ordered by ID (DB insertion order)
    const hotspots = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: route.itinerary_route_ID,
        deleted: 0,
      },
      orderBy: { route_hotspot_ID: 'asc' },
    });
    
    console.log(`\nFound ${hotspots.length} hotspots in this route:\n`);
    
    // Extract chronological order from start times
    const byTime = [...hotspots].sort((a, b) => {
      const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
      const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
      return aTime - bTime;
    });
    
    // Type names
    const typeNames: Record<number, string> = {
      1: 'START',
      2: 'TRAVEL_INTER',
      3: 'TRAVEL_INTRA',
      4: 'ATTRACTION',
      5: 'TRAVEL_TO_HOTEL',
      6: 'HOTEL_CHECKIN',
      7: 'DROP_OFF',
    };
    
    // Check each hotspot
    const issues: string[] = [];
    
    for (let i = 0; i < hotspots.length; i++) {
      const h = hotspots[i];
      const typeName = typeNames[h.item_type] || `TYPE_${h.item_type}`;
      const startTime = h.hotspot_start_time ? new Date(h.hotspot_start_time).toISOString().substring(11, 19) : 'N/A';
      const endTime = h.hotspot_end_time ? new Date(h.hotspot_end_time).toISOString().substring(11, 19) : 'N/A';
      
      console.log(`${i + 1}. [DB Order] ${typeName.padEnd(15)} | Start: ${startTime} | End: ${endTime} | Order: ${h.hotspot_order}`);
      
      // Check 1: Chronological ordering
      const chronoIndex = byTime.indexOf(h);
      if (chronoIndex !== i) {
        issues.push(`Row ${i + 1} (${typeName}) is out of chronological order - should be at position ${chronoIndex + 1}`);
      }
      
      // Check 2: Route-end violations
      if (h.hotspot_end_time && h.item_type === 7) { // DROP_OFF
        const endSeconds = new Date(h.hotspot_end_time).getTime();
        const routeEndSeconds = new Date(route.route_end_time).getTime();
        if (endSeconds > routeEndSeconds) {
          const minOver = Math.floor((endSeconds - routeEndSeconds) / 60000);
          issues.push(`Row ${i + 1} (DROP_OFF) exceeds route_end_time by ${minOver} minutes`);
        }
      }
    }
    
    if (issues.length > 0) {
      console.log(`\n⚠️  ISSUES FOUND IN THIS ROUTE:`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
    } else {
      console.log(`\n✅ All checks passed for this route`);
    }
  }
  
  console.log('\n\n=== CHRONOLOGICAL VIEW (ALL ROUTES COMBINED) ===\n');
  
  // Get all hotspots across all routes, sorted by time
  const allHotspots = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: planId,
      deleted: 0,
    },
  });
  
  const sorted = [...allHotspots].sort((a, b) => {
    const aTime = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : 0;
    const bTime = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : 0;
    return aTime - bTime;
  });
  
  const typeNames: Record<number, string> = {
    1: 'START',
    2: 'TRAVEL_INTER',
    3: 'TRAVEL_INTRA',
    4: 'ATTRACTION',
    5: 'TRAVEL_TO_HOTEL',
    6: 'HOTEL_CHECKIN',
    7: 'DROP_OFF',
  };
  
  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    const typeName = typeNames[h.item_type] || `TYPE_${h.item_type}`;
    const startTime = h.hotspot_start_time ? new Date(h.hotspot_start_time).toISOString().substring(11, 19) : 'N/A';
    const route = routes.find(r => r.itinerary_route_ID === h.itinerary_route_ID);
    
    console.log(`${i + 1}. [Route ${route?.route_number}] ${typeName.padEnd(15)} | ${startTime} | Order: ${h.hotspot_order} | HotspotID: ${h.hotspot_ID}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
