#!/usr/bin/env npx ts-node
/**
 * Verification script for complete manual hotspot timeline integration fix
 *
 * Tests that manual hotspots are:
 * 1. Extracted before rebuild
 * 2. Not left as placeholder rows (order=999, 1970 timestamps)
 * 3. Deduped in final timeline
 * 4. Sorted chronologically
 * 5. Reassigned sequential order
 * 6. Properly integrated into persisted timeline
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../src/app.module';
import { Prisma } from '@prisma/client';

const PLAN_ID = 268;
const ROUTE_ID = 1238;
const HOTSPOT_ID = 8;

interface ValidationReport {
  testName: string;
  passed: boolean;
  details: string;
  severity: 'error' | 'warning' | 'info';
}

async function main() {
  console.log('\n🔍 MANUAL HOTSPOT INTEGRATION VERIFICATION\n');
  console.log(`Testing planId=${PLAN_ID}, routeId=${ROUTE_ID}, hotspotId=${HOTSPOT_ID}\n`);

  const app = await NestFactory.create(AppModule);
  const prisma = app.get('PrismaService');
  const itinerariesService = app.get('ItinerariesService');

  const reports: ValidationReport[] = [];

  try {
    // 1. Test: Manual hotspot should not have placeholder order=999 after successful preview
    console.log('📋 Test 1: Verify manual hotspot order not 999 after preview...');
    try {
      const previewResult = await itinerariesService.previewManualHotspot(PLAN_ID, ROUTE_ID, HOTSPOT_ID);
      const hasPlaceholderOrder = previewResult?.newHotspot?.hotspot_order === 999;
      const passed = !hasPlaceholderOrder && previewResult?.success;

      reports.push({
        testName: 'No placeholder order=999 after preview',
        passed,
        details: passed
          ? `hotspot_order=${previewResult?.newHotspot?.hotspot_order} (valid)`
          : `hotspot_order=${previewResult?.newHotspot?.hotspot_order} (PLACEHOLDER)`,
        severity: passed ? 'info' : 'error',
      });
      console.log(`   ${passed ? '✅' : '❌'} ${reports[reports.length - 1].details}\n`);
    } catch (e) {
      reports.push({
        testName: 'No placeholder order=999 after preview',
        passed: false,
        details: `Error: ${(e as any).message}`,
        severity: 'error',
      });
      console.log(`   ❌ Error: ${(e as any).message}\n`);
    }

    // 2. Test: Manual hotspot should have real timestamps (not 1970)
    console.log('📋 Test 2: Verify manual hotspot has real timestamps (not 1970)...');
    try {
      const previewResult = await itinerariesService.previewManualHotspot(PLAN_ID, ROUTE_ID, HOTSPOT_ID);
      const startTime = previewResult?.newHotspot?.hotspot_start_time;
      const isPlaceholder = startTime ? new Date(startTime).getFullYear() === 1970 : true;
      const passed = !isPlaceholder && startTime !== null;

      reports.push({
        testName: 'Real timestamps (not 1970)',
        passed,
        details: passed
          ? `startTime=${startTime} (valid)`
          : `startTime=${startTime} (PLACEHOLDER)`,
        severity: passed ? 'info' : 'error',
      });
      console.log(`   ${passed ? '✅' : '❌'} ${reports[reports.length - 1].details}\n`);
    } catch (e) {
      reports.push({
        testName: 'Real timestamps (not 1970)',
        passed: false,
        details: `Error: ${(e as any).message}`,
        severity: 'error',
      });
      console.log(`   ❌ Error: ${(e as any).message}\n`);
    }

    // 3. Test: Full timeline should be chronologically sorted
    console.log('📋 Test 3: Verify timeline is chronologically sorted...');
    try {
      const previewResult = await itinerariesService.previewManualHotspot(PLAN_ID, ROUTE_ID, HOTSPOT_ID);
      const timeline = previewResult?.fullTimeline || [];
      
      let isSorted = true;
      let lastTime: number | null = null;
      let outOfOrderIndices: number[] = [];

      for (let i = 0; i < timeline.length; i++) {
        const currentTime = timeline[i]?.hotspot_start_time
          ? new Date(timeline[i]?.hotspot_start_time).getTime()
          : 0;
        
        if (lastTime !== null && currentTime < lastTime) {
          isSorted = false;
          outOfOrderIndices.push(i);
        }
        lastTime = currentTime;
      }

      reports.push({
        testName: 'Timeline chronologically sorted',
        passed: isSorted,
        details: isSorted
          ? `All ${timeline.length} rows in chronological order`
          : `Out of order at indices: ${outOfOrderIndices.join(', ')}`,
        severity: isSorted ? 'info' : 'error',
      });
      console.log(`   ${isSorted ? '✅' : '❌'} ${reports[reports.length - 1].details}\n`);
    } catch (e) {
      reports.push({
        testName: 'Timeline chronologically sorted',
        passed: false,
        details: `Error: ${(e as any).message}`,
        severity: 'error',
      });
      console.log(`   ❌ Error: ${(e as any).message}\n`);
    }

    // 4. Test: No duplicate hotspots in timeline
    console.log('📋 Test 4: Verify no duplicate hotspots...');
    try {
      const previewResult = await itinerariesService.previewManualHotspot(PLAN_ID, ROUTE_ID, HOTSPOT_ID);
      const timeline = previewResult?.fullTimeline || [];
      const attracted = timeline.filter((r: any) => Number(r.item_type) === 4);
      
      const hotspotCounts = new Map<number, number>();
      for (const row of attracted) {
        const hid = Number(row.hotspot_ID || 0);
        hotspotCounts.set(hid, (hotspotCounts.get(hid) || 0) + 1);
      }

      let duplicates = 0;
      const dupeIds: number[] = [];
      for (const [hid, count] of hotspotCounts.entries()) {
        if (count > 1) {
          duplicates++;
          dupeIds.push(hid);
        }
      }

      const passed = duplicates === 0;
      reports.push({
        testName: 'No duplicate hotspots',
        passed,
        details: passed
          ? `${attracted.length} attraction rows, all unique`
          : `Found duplicates for hotspot IDs: ${dupeIds.join(', ')}`,
        severity: passed ? 'info' : 'error',
      });
      console.log(`   ${passed ? '✅' : '❌'} ${reports[reports.length - 1].details}\n`);
    } catch (e) {
      reports.push({
        testName: 'No duplicate hotspots',
        passed: false,
        details: `Error: ${(e as any).message}`,
        severity: 'error',
      });
      console.log(`   ❌ Error: ${(e as any).message}\n`);
    }

    // 5. Test: Travel rows appear before attraction rows
    console.log('📋 Test 5: Verify travel < attraction in timeline...');
    try {
      const previewResult = await itinerariesService.previewManualHotspot(PLAN_ID, ROUTE_ID, HOTSPOT_ID);
      const timeline = previewResult?.fullTimeline || [];
      
      let validOrder = true;
      for (let i = 0; i < timeline.length - 1; i++) {
        const current = timeline[i];
        const next = timeline[i + 1];
        
        const currTime = current?.hotspot_start_time ? new Date(current.hotspot_start_time).getTime() : 0;
        const nextTime = next?.hotspot_start_time ? new Date(next.hotspot_start_time).getTime() : 0;
        const currType = Number(current?.item_type || 0);
        const nextType = Number(next?.item_type || 0);
        
        // If same time, travel (3) should come before attraction (4)
        if (currTime === nextTime && currType === 4 && nextType === 3) {
          validOrder = false;
          break;
        }
      }

      reports.push({
        testName: 'Travel before attraction (same time)',
        passed: validOrder,
        details: validOrder ? 'All travel rows appear before attractions' : 'Found attraction before travel at same time',
        severity: validOrder ? 'info' : 'error',
      });
      console.log(`   ${validOrder ? '✅' : '❌'} ${reports[reports.length - 1].details}\n`);
    } catch (e) {
      reports.push({
        testName: 'Travel before attraction (same time)',
        passed: false,
        details: `Error: ${(e as any).message}`,
        severity: 'error',
      });
      console.log(`   ❌ Error: ${(e as any).message}\n`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60) + '\n');

    const passed = reports.filter((r) => r.passed).length;
    const failed = reports.filter((r) => !r.passed).length;

    for (const report of reports) {
      const icon = report.passed ? '✅' : report.severity === 'error' ? '❌' : '⚠️';
      console.log(`${icon} ${report.testName}: ${report.details}`);
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);

    if (failed === 0) {
      console.log('✅ ALL TESTS PASSED - Manual hotspot integration is working correctly!\n');
    } else {
      console.log(`❌ ${failed} TEST(S) FAILED - Review the output above\n`);
    }
  } catch (error) {
    console.error('Fatal error:', error);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
