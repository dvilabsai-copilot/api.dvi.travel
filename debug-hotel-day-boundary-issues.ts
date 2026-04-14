#!/usr/bin/env npx ts-node

/**
 * INVESTIGATION SCRIPT: Hotel/Day-Boundary Issues in DVI202604229
 * 
 * This script:
 * 1. Loads quote DVI202604229 
 * 2. Fetches raw DB rows for routes 1252-1255
 * 3. Isolates hotel rows (item_type=5 TRAVEL_TO_HOTEL, item_type=6 CHECKIN)
 * 4. Compares DB order vs time-based order vs API output
 * 5. Identifies violations and anomalies
 */

import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

interface DbRow {
  route_hotspot_ID: number;
  itinerary_route_ID: number;
  item_type: number;
  hotspot_order: number;
  hotspot_start_time: Date | null;
  hotspot_end_time: Date | null;
  createdby: number;
  is_conflict: number;
  conflict_reason: string | null;
  status: number;
  deleted: number;
}

interface RouteInfo {
  itinerary_route_ID: number;
  itinerary_route_date: string;
  route_start_time: Date | null;
  route_end_time: Date | null;
  location_name: string;
  next_visiting_location: string;
}

function timeToString(date: Date | null): string {
  if (!date) return 'NULL';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getItemTypeName(type: number): string {
  const names: Record<number, string> = {
    1: 'START',
    2: 'UNKNOWN',
    3: 'TRAVEL',
    4: 'ATTRACTION',
    5: 'TRAVEL_TO_HOTEL',
    6: 'CHECKIN',
    7: 'DROP_OFF',
  };
  return names[type] || `UNKNOWN_${type}`;
}

function getDurationMinutes(start: Date | null, end: Date | null): number {
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / 60000);
}

async function main() {
  try {
    console.log('\n========== HOTEL DAY-BOUNDARY INVESTIGATION ==========\n');
    console.log('Quote: DVI202604229');
    
    // Step 1: Get plan
    const plan = await (prisma as any).dvi_itinerary_plan_details.findFirst({
      where: {
        itinerary_quote_ID: 'DVI202604229',
        deleted: 0,
      },
    });

    if (!plan) {
      console.log('❌ Plan not found for DVI202604229');
      return;
    }

    const planId = plan.itinerary_plan_ID;
    console.log(`Plan ID: ${planId}`);

    // Step 2: Get routes 1252-1255
    const targetRoutes = [1252, 1253, 1254, 1255];
    
    for (const routeId of targetRoutes) {
      const route = await (prisma as any).dvi_itinerary_route_details.findFirst({
        where: { itinerary_route_ID: routeId, itinerary_plan_ID: planId },
      });

      if (!route) {
        console.log(`\n⚠️  Route ${routeId} not found`);
        continue;
      }

      const dayNumber = route.itinerary_route_order || routeId;
      const routeDate = route.itinerary_route_date ? new Date(route.itinerary_route_date).toISOString().split('T')[0] : 'UNKNOWN';
      const routeStart = route.route_start_time ? timeToString(new Date(route.route_start_time)) : 'NULL';
      const routeEnd = route.route_end_time ? timeToString(new Date(route.route_end_time)) : 'NULL';

      console.log(`\n${'='.repeat(70)}`);
      console.log(`ROUTE ${routeId} (Day ${dayNumber}) - ${routeDate}`);
      console.log(`Route boundaries: ${routeStart} → ${routeEnd}`);
      console.log(`From: ${route.location_name} | To: ${route.next_visiting_location}`);

      // Step 3: Fetch ALL hotspot rows for this route (ordered by DB insertion order)
      const allRows = await (prisma as any).dvi_itinerary_route_hotspot_details.findMany({
        where: {
          itinerary_plan_ID: planId,
          itinerary_route_ID: routeId,
          deleted: 0,
        },
        orderBy: [
          { hotspot_order: 'asc' },
          { route_hotspot_ID: 'asc' },
        ],
      });

      if (allRows.length === 0) {
        console.log('  No rows found in DB');
        continue;
      }

      console.log(`\n  Total DB rows: ${allRows.length}`);

      // Step 4: Separate hotel rows
      const hotelRows = allRows.filter((r: any) => r.item_type === 5 || r.item_type === 6);
      const otherRows = allRows.filter((r: any) => r.item_type !== 5 && r.item_type !== 6);

      // Print all rows with details
      console.log(`\n  DB INSERTION ORDER (${allRows.length} total):`);
      console.log(`  ${'─'.repeat(130)}`);
      console.log(`  Order │ ID   │ Type              │ Start Time │ End Time   │ Duration │ is_conflict │ Reason`);
      console.log(`  ${'─'.repeat(130)}`);

      for (const row of allRows) {
        const typeLabel = getItemTypeName(row.item_type);
        const start = timeToString(row.hotspot_start_time);
        const end = timeToString(row.hotspot_end_time);
        const duration = getDurationMinutes(row.hotspot_start_time, row.hotspot_end_time);
        const conflict = row.is_conflict === 1 ? 'YES' : 'no';
        const reason = row.conflict_reason || '(none)';
        
        console.log(
          `  ${String(row.hotspot_order).padStart(5)} │ ${String(row.route_hotspot_ID).padStart(4)} │ ` +
          `${typeLabel.padEnd(17)} │ ${start} │ ${end} │ ${String(duration).padStart(7)}m │ ${conflict.padEnd(11)} │ ${reason}`
        );
      }

      // Step 5: Chronological sort
      const chronoRows = [...allRows].sort((a: any, b: any) => {
        const aStart = a.hotspot_start_time ? new Date(a.hotspot_start_time).getTime() : Infinity;
        const bStart = b.hotspot_start_time ? new Date(b.hotspot_start_time).getTime() : Infinity;
        return aStart - bStart;
      });

      console.log(`\n  CHRONOLOGICAL ORDER (sorted by start_time):`);
      console.log(`  ${'─'.repeat(130)}`);
      console.log(`  Order │ ID   │ Type              │ Start Time │ End Time   │ Duration │ Violations`);
      console.log(`  ${'─'.repeat(130)}`);

      for (let i = 0; i < chronoRows.length; i++) {
        const row = chronoRows[i];
        const typeLabel = getItemTypeName(row.item_type);
        const start = timeToString(row.hotspot_start_time);
        const end = timeToString(row.hotspot_end_time);
        const duration = getDurationMinutes(row.hotspot_start_time, row.hotspot_end_time);
        
        // Check violations
        const violations: string[] = [];
        
        // Violation: starts before route start
        if (row.hotspot_start_time && route.route_start_time) {
          const rowStart = new Date(row.hotspot_start_time).getTime();
          const routeStart = new Date(route.route_start_time).getTime();
          if (rowStart < routeStart) {
            violations.push('BEFORE_ROUTE_START');
          }
        }
        
        // Violation: ends after route end
        if (row.hotspot_end_time && route.route_end_time) {
          const rowEnd = new Date(row.hotspot_end_time).getTime();
          const routeEnd = new Date(route.route_end_time).getTime();
          if (rowEnd > routeEnd) {
            violations.push('AFTER_ROUTE_END');
          }
        }
        
        // Violation: start > end
        if (row.hotspot_start_time && row.hotspot_end_time) {
          const rowStart = new Date(row.hotspot_start_time).getTime();
          const rowEnd = new Date(row.hotspot_end_time).getTime();
          if (rowStart > rowEnd) {
            violations.push('START_GT_END');
          }
        }
        
        // Violation: duration > 6 hours for travel
        if ((row.item_type === 5 || row.item_type === 3) && duration > 360) {
          violations.push(`LONG_TRAVEL_${duration}m`);
        }

        // Gap from previous
        const violationStr = violations.length > 0 ? violations.join(', ') : '(none)';
        
        console.log(
          `  ${String(i + 1).padStart(5)} │ ${String(row.route_hotspot_ID).padStart(4)} │ ` +
          `${typeLabel.padEnd(17)} │ ${start} │ ${end} │ ${String(duration).padStart(7)}m │ ${violationStr}`
        );
      }

      // Step 6: Analyze hotel rows specifically
      if (hotelRows.length > 0) {
        console.log(`\n  🏨 HOTEL ROWS ANALYSIS (${hotelRows.length} hotel rows):`);
        console.log(`  ${'─'.repeat(130)}`);

        for (const row of hotelRows) {
          const typeLabel = getItemTypeName(row.item_type);
          const start = timeToString(row.hotspot_start_time);
          const end = timeToString(row.hotspot_end_time);
          const duration = getDurationMinutes(row.hotspot_start_time, row.hotspot_end_time);

          console.log(`\n    ${typeLabel} (ID ${row.route_hotspot_ID}, order ${row.hotspot_order})`);
          console.log(`      Time: ${start} → ${end} (${duration}m)`);
          console.log(`      Status: ${row.status}, Deleted: ${row.deleted}, Conflict: ${row.is_conflict}`);
          
          if (row.hotspot_start_time && route.route_start_time) {
            const rowStart = new Date(row.hotspot_start_time);
            const routeStart = new Date(route.route_start_time);
            if (rowStart < routeStart) {
              console.log(`      ⚠️  STARTS BEFORE ROUTE START by ${Math.round((routeStart.getTime() - rowStart.getTime()) / 60000)}m`);
            }
          }

          if (row.hotspot_end_time && route.route_end_time) {
            const rowEnd = new Date(row.hotspot_end_time);
            const routeEnd = new Date(route.route_end_time);
            if (rowEnd > routeEnd) {
              console.log(`      ⚠️  ENDS AFTER ROUTE END by ${Math.round((rowEnd.getTime() - routeEnd.getTime()) / 60000)}m`);
            }
          }

          if (row.hotspot_start_time && row.hotspot_end_time) {
            const rowStart = new Date(row.hotspot_start_time);
            const rowEnd = new Date(row.hotspot_end_time);
            if (rowStart > rowEnd) {
              console.log(`      ⚠️  START > END (reversed times!)`);
            }
          }

          if (row.conflict_reason) {
            console.log(`      Conflict reason: ${row.conflict_reason}`);
          }
        }
      }

      // Step 7: Check for large gaps
      console.log(`\n  ⏱️  GAP ANALYSIS (between consecutive rows):`);
      console.log(`  ${'─'.repeat(130)}`);

      let hasLargeGaps = false;
      for (let i = 0; i < chronoRows.length - 1; i++) {
        const curr = chronoRows[i];
        const next = chronoRows[i + 1];
        
        if (curr.hotspot_end_time && next.hotspot_start_time) {
          const gapMs = new Date(next.hotspot_start_time).getTime() - new Date(curr.hotspot_end_time).getTime();
          const gapMinutes = Math.round(gapMs / 60000);
          
          // Flag gaps > 1 hour
          if (gapMinutes > 60) {
            hasLargeGaps = true;
            const currType = getItemTypeName(curr.item_type);
            const nextType = getItemTypeName(next.item_type);
            const currEnd = timeToString(curr.hotspot_end_time);
            const nextStart = timeToString(next.hotspot_start_time);
            
            console.log(
              `    ${currType} ends ${currEnd} → ${nextType} starts ${nextStart}: ` +
              `${gapMinutes} minute gap`
            );
          }
        }
      }

      if (!hasLargeGaps) {
        console.log(`    (no gaps > 1 hour)`);
      }
    }

    // Step 8: Fetch API response to compare
    console.log(`\n\n========== API RESPONSE COMPARISON ==========\n`);
    
    try {
      const response = await axios.get(`http://localhost:3000/api/v1/itineraries/details/DVI202604229`, {
        headers: { 'X-Debug-Quote': '268' },
      });

      const data = response.data;

      if (data.days && Array.isArray(data.days)) {
        for (const day of data.days) {
          if (![1, 2, 3, 4].includes(day.dayNumber)) continue;

          console.log(`\nDay ${day.dayNumber} (${day.date})`);
          console.log(`  Route ID: ${day.id}`);
          console.log(`  Segments (${day.segments?.length || 0} total):`);
          
          if (day.segments && day.segments.length > 0) {
            for (const seg of day.segments) {
              const type = seg.type || 'unknown';
              const timeStr = seg.timeRange || seg.time || seg.visitTime || '(no time)';
              const name = seg.name || seg.from || '(no name)';
              
              console.log(`    - ${type.padEnd(12)} | ${timeStr} | ${name}`);
            }
          }
        }
      }
    } catch (err) {
      console.log(`⚠️  Could not fetch API response: ${(err as any).message}`);
    }

    console.log(`\n========== END INVESTIGATION ==========\n`);

  } catch (error) {
    console.error('ERROR:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
