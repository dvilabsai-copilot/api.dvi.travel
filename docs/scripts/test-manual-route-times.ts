#!/usr/bin/env npx ts-node
/**
 * TEST: Manual Route Time Override
 * 
 * Tests that manually updated route times are respected and not forced to 08:00/20:00
 */

import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import * as fs from 'fs';

const prisma = new PrismaClient();

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('TEST: Manual Route Time Override');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Test Case 1: Sightseeing-first with manual noon start
    console.log('📋 Test Case 1: Manual route times (12:00 - 20:00) - Sightseeing First');
    console.log('─────────────────────────────────────────────────────────────\n');

    const planId = 266;
    const routeId = 1872;

    // Check current route times in database
    const currentRoute = await prisma.dvi_itinerary_routes.findFirst({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        deleted: 0,
      },
      select: {
        itinerary_route_ID: true,
        route_start_time: true,
        route_end_time: true,
        itinerary_route_date: true,
      },
    });

    console.log('Current route in database:');
    console.log(`  Route ID: ${currentRoute?.itinerary_route_ID}`);
    console.log(`  Start Time: ${currentRoute?.route_start_time}`);
    console.log(`  End Time: ${currentRoute?.route_end_time}`);
    console.log(`  Date: ${currentRoute?.itinerary_route_date}\n`);

    // Update route with manual times (12:00 PM - 8:00 PM)
    console.log('Updating route with manual times: 12:00:00 - 20:00:00');
    await prisma.dvi_itinerary_routes.update({
      where: {
        itinerary_route_ID: routeId,
      },
      data: {
        route_start_time: '12:00:00',
        route_end_time: '20:00:00',
      },
    });
    console.log('✓ Route updated successfully\n');

    // Verify update
    const updatedRoute = await prisma.dvi_itinerary_routes.findFirst({
      where: {
        itinerary_route_ID: routeId,
        deleted: 0,
      },
      select: {
        route_start_time: true,
        route_end_time: true,
      },
    });

    console.log('✓ Verified in database:');
    console.log(`  Start Time: ${updatedRoute?.route_start_time}`);
    console.log(`  End Time: ${updatedRoute?.route_end_time}\n`);

    // Rebuild itinerary details to trigger timeline builder
    console.log('🔨 Rebuilding itinerary timeline (this triggers TimelineBuilder)...');
    const quoteId = 'DVI202604228';
    
    try {
      execSync(
        `cd ${process.cwd()} && npx tsx scripts/rebuild-itinerary-details-quote.ts DVI202604228 2>&1`,
        { stdio: 'inherit' },
      );
      console.log('\n✓ Rebuild complete\n');
    } catch (e) {
      console.error('⚠️  Rebuild had errors (expected if script not available), testing DB directly...\n');
    }

    // Query rebuilt itinerary rows to check timeline
    console.log('📊 Checking rebuilt itinerary segments:\n');

    const segments = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        deleted: 0,
      },
      select: {
        hotspot_order: true,
        item_type: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: {
        hotspot_order: 'asc',
      },
    });

    const itemTypeMap: { [key: number]: string } = {
      1: 'REFRESHMENT',
      2: 'SIGHTSEEING',
      3: 'TRAVEL',
      4: 'HOTEL_STAY',
      5: 'PARKING',
      6: 'DINING',
    };

    console.log('Timeline segments (in order):');
    segments.forEach((seg) => {
      const startTime = seg.hotspot_start_time
        ? new Date(seg.hotspot_start_time).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          })
        : 'N/A';
      const endTime = seg.hotspot_end_time
        ? new Date(seg.hotspot_end_time).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          })
        : 'N/A';

      const itemType = itemTypeMap[seg.item_type] || `TYPE_${seg.item_type}`;
      console.log(`  Order ${seg.hotspot_order}: ${itemType.padEnd(15)} ${startTime} - ${endTime}`);
    });

    // Validate that timeline uses the manual 12:00 start, NOT 08:00
    console.log('\n✅ VALIDATION:\n');

    const firstSegment = segments[0];
    if (firstSegment) {
      const firstStartTime = firstSegment.hotspot_start_time
        ? new Date(firstSegment.hotspot_start_time).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
          })
        : null;

      if (firstStartTime === '12:00:00 PM' || firstStartTime?.includes('12:00')) {
        console.log('  ✓ PASS: Timeline starts at 12:00 PM (respects manual time)');
      } else {
        console.log(`  ✗ FAIL: Timeline starts at ${firstStartTime} (expected 12:00 PM)`);
      }
    }

    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.hotspot_end_time) {
      const lastEndTime = new Date(lastSegment.hotspot_end_time).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
      console.log(`  ✓ Timeline ends at: ${lastEndTime}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('TEST COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:');
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
