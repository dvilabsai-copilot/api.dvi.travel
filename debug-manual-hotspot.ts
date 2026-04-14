/**
 * Debug Script: Manual Hotspot Insertion (Using Real Service)
 * 
 * Purpose: Call the actual previewManualHotspot() service method
 * to test if manual hotspots are properly injected into timeline.
 * 
 * Values:
 * - planId = 268
 * - routeId = 1238
 * - hotspotId = 8
 * 
 * This script:
 * 1. Calls the actual previewManualHotspot() service method
 * 2. Then commits the transaction (doesn't rollback)
 * 3. Queries final DB state to verify manual hotspot has valid order/timing
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { ItinerariesService } from './src/modules/itineraries/itineraries.service';
import { PrismaService } from './src/prisma.service';

async function debugManualHotspot() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const itinerariesService = app.get(ItinerariesService);
  const prisma = app.get(PrismaService);

  const planId = 268;
  const routeId = 1238;
  const hotspotId = 8;

  console.log('\n\n' + '='.repeat(100));
  console.log('🔍 DEBUG: MANUAL HOTSPOT INSERTION (USING REAL SERVICE)');
  console.log('='.repeat(100));
  console.log(`📋 Plan ID: ${planId}`);
  console.log(`📍 Route ID: ${routeId}`);
  console.log(`📌 Hotspot ID: ${hotspotId}`);
  console.log('='.repeat(100) + '\n');

  try {
    console.log('[STEP 1] Calling previewManualHotspot()...');
    const preview = await itinerariesService.previewManualHotspot(
      planId,
      routeId,
      hotspotId
    );
    console.log('✅ previewManualHotspot() completed');
    console.log(`   - success: ${preview.success}`);
    console.log(`   - selectedIncluded: ${preview.selectedIncluded}`);
    console.log(`   - newHotspot found: ${!!preview.newHotspot}`);

    if (preview.newHotspot) {
      console.log(`   - hotspot_order: ${preview.newHotspot.hotspot_order}`);
      console.log(`   - hotspot_start_time: ${preview.newHotspot.hotspot_start_time}`);
      console.log(`   - hotspot_end_time: ${preview.newHotspot.hotspot_end_time}`);
    }

    console.log('\n[STEP 2] Querying final DB state...');
    const finalRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        deleted: 0,
      },
      orderBy: { hotspot_order: 'asc' },
    });

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`📊 FINAL TIMELINE IN DB (${finalRows.length} total rows)`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    finalRows.forEach((row, idx) => {
      const isManual = Number(row.hotspot_plan_own_way || 0) === 1;
      const isTarget = Number(row.hotspot_ID) === hotspotId;
      const marker = isTarget ? '⭐' : '  ';

      console.log(`${marker} [${idx + 1}] Route Hotspot ID: ${row.route_hotspot_ID}`);
      console.log(`    Hotspot ID: ${row.hotspot_ID}`);
      console.log(`    Order: ${row.hotspot_order}`);
      console.log(`    Time: ${row.hotspot_start_time} → ${row.hotspot_end_time}`);
      console.log(`    Manual Flag: ${isManual}`);
      console.log(`    Conflict Flag: ${Number(row.is_conflict || 0) === 1}`);
      console.log('');
    });

    const manualRow = finalRows.find((r) => Number(r.hotspot_ID) === hotspotId);
    console.log(`🎯 TARGET MANUAL HOTSPOT (ID: ${hotspotId}):`);
    if (manualRow) {
      console.log(`\n✅ FOUND IN TIMELINE`);
      console.log(`   - route_hotspot_ID: ${manualRow.route_hotspot_ID}`);
      console.log(`   - hotspot_order: ${manualRow.hotspot_order}`);
      console.log(`   - hotspot_start_time: ${manualRow.hotspot_start_time}`);
      console.log(`   - hotspot_end_time: ${manualRow.hotspot_end_time}`);
      console.log(`   - is_manual: ${Number(manualRow.hotspot_plan_own_way) === 1}`);
      console.log(`   - is_conflict: ${Number(manualRow.is_conflict) === 1}`);

      // Validation checks
      console.log(`\n🔍 VALIDATION CHECKS:`);
      const hasValidOrder = manualRow.hotspot_order && manualRow.hotspot_order < 999;
      const hasValidTimes = manualRow.hotspot_start_time && manualRow.hotspot_end_time &&
        String(manualRow.hotspot_start_time) !== '1970-01-01T00:00:00.000Z' &&
        String(manualRow.hotspot_end_time) !== '1970-01-01T00:00:00.000Z';
      const isMarkedManual = Number(manualRow.hotspot_plan_own_way) === 1;

      console.log(`   ✓ Has valid order (< 999): ${hasValidOrder ? '✅' : '❌'}`);
      console.log(`   ✓ Has valid times (not placeholder): ${hasValidTimes ? '✅' : '❌'}`);
      console.log(`   ✓ Marked as manual: ${isMarkedManual ? '✅' : '❌'}`);

      if (hasValidOrder && hasValidTimes && isMarkedManual) {
        console.log(`\n🎉 FIX VERIFIED: Hotspot inserted with proper timings!`);
      } else {
        console.log(`\n⚠️  ISSUE REMAINS: Missing valid order or timings`);
      }
    } else {
      console.log(`\n❌ NOT FOUND IN TIMELINE`);
    }

    console.log('\n' + '='.repeat(100));
    console.log('✅ DEBUG SCRIPT COMPLETED');
    console.log('='.repeat(100) + '\n');

  } catch (error) {
    console.error('\n❌ Error occurred:');
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error) {
      console.error(error.stack);
    }
  } finally {
    await app.close();
  }
}

// Run the debug function
debugManualHotspot()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Fatal Error:', error);
    process.exit(1);
  });
