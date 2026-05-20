import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const prisma = new PrismaClient();

async function testLowPriorityRemovalFix() {
  try {
    console.log('[TEST] Testing LOW_PRIORITY_RESOLVED_TIMELINE_INVALID fix');
    console.log('[TEST] Plan 381, Route 4353, Candidate Hotspot 217');
    console.log('');

    const planId = 381;
    const routeId = 4353;
    const candidateHotspotId = 217;
    const selectedHotspotIds = [217];

    // Get the route to understand day end time
    const route = await prisma.routes.findUnique({
      where: { id: routeId },
      select: {
        id: true,
        day_end_time: true,
        route_name: true,
        route_day: true,
      },
    });

    if (!route) {
      console.error(`[ERROR] Route ${routeId} not found`);
      return;
    }

    console.log(`[ROUTE] ${route.route_name} (Day ${route.route_day})`);
    console.log(`[ROUTE] Day end time: ${route.day_end_time}`);
    console.log('');

    // Get candidate hotspot
    const hotspot = await prisma.hotspots.findUnique({
      where: { id: candidateHotspotId },
      select: {
        id: true,
        location_name: true,
        city_code: true,
        priority_level: true,
      },
    });

    if (hotspot) {
      console.log(`[HOTSPOT] ${hotspot.location_name} (Priority: ${hotspot.priority_level})`);
    }

    console.log('');
    console.log('[TEST] Calling buildManualInsertionFit endpoint with preview...');
    console.log('');

    // In a real test, you would call the API endpoint
    // For now, we'll just show the test structure
    console.log('[EXPECTED OUTCOME]');
    console.log('- Either: Preview succeeds with final timeline NOT containing hotspot 220');
    console.log('- Or: Error message clearly identifies which hotspot/row still contains the removed hotspot');
    console.log('');
    console.log('[FIX DETAILS]');
    console.log('1. buildMatrixRouteTimelineAfterLowPriorityRemoval now:');
    console.log('   - Checks toHotspotId and fromHotspotId in addition to locationId/hotspot_ID');
    console.log('   - Applies final sanitization filter to ensure NO removed hotspots remain');
    console.log('   - Includes helper function containsRemovedHotspotId()');
    console.log('');
    console.log('2. validateResolvedLowPriorityTimeline now:');
    console.log('   - Logs debug information when validation fails');
    console.log('   - Shows which hotspot IDs are in timeline vs which should be removed');
    console.log('   - Lists specific rows that contain removed hotspots');
    console.log('');

  } catch (error) {
    console.error('[ERROR]', error);
  } finally {
    await prisma.$disconnect();
  }
}

testLowPriorityRemovalFix();
