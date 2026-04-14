/**
 * Debug script for DVI202604230 itinerary segment order investigation
 *  
 * Investigates:
 * 1. Why travel segments appear after attractions (chronological misplacement)
 * 2. Why post-route-end rows still appear in response
 * 3. Why checkin time anchors incorrectly (before travel completion)
 */

import axios, { AxiosError } from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const QUOTE_ID = 'DVI202604230';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3434';

function timeToMinutes(timeStr: string | null): number {
  if (!timeStr) return 0;
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return 0;
  
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const ampm = match[3].toUpperCase();
  
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  
  return hours * 60 + minutes;
}

function formatTime(date: Date | null): string | null {
  if (!date) return null;
  const dt = new Date(date);
  if (isNaN(dt.getTime())) return null;
  
  let hh = dt.getUTCHours();
  const mm = String(dt.getUTCMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  
  return `${String(hh).padStart(2, '0')}:${mm} ${ampm}`;
}

function getItemTypeLabel(itemType: number): string {
  const labelMap: Record<number, string> = {
    1: 'START',
    2: 'TRAVEL_INTER',
    3: 'TRAVEL_INTRA',
    4: 'ATTRACTION',
    5: 'TRAVEL_TO_HOTEL',
    6: 'CHECKIN',
    7: 'DROP_OFF'
  };
  return labelMap[itemType] || `UNKNOWN(${itemType})`;
}

async function main() {
  try {
    console.log('\n========== PHASE 1: PROOF-BASED INVESTIGATION ==========\n');
    
    // Step 1: Get plan ID from quote ID
    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: QUOTE_ID, deleted: 0 },
    });
    
    if (!plan) {
      console.error(`Quote ${QUOTE_ID} not found`);
      process.exit(1);
    }
    
    const planId = plan.itinerary_plan_ID;
    console.log(`[QuoteResolution] Quote: ${QUOTE_ID} → Plan ID: ${planId}\n`);
    
    // Step 2: Fetch all routes for this plan
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        deleted: 0,
        status: 1,
      },
      orderBy: { itinerary_route_ID: 'asc' },
    });
    
    console.log(`[RouteFetch] Found ${routes.length} routes for plan ${planId}\n`);
    
    // Step 3: For each route, fetch and analyze hotspot rows
    for (let routeIdx = 0; routeIdx < routes.length; routeIdx++) {
      const route = routes[routeIdx];
      const routeId = route.itinerary_route_ID;
      const dayNumber = routeIdx + 1;
      const routeDate = route.itinerary_route_date;
      const routeStartTime = formatTime(route.route_start_time as any);
      const routeEndTime = formatTime(route.route_end_time as any);
      
      console.log(`${'='.repeat(80)}`);
      console.log(`DAY ${dayNumber} | Route ID: ${routeId} | Date: ${routeDate.toISOString().split('T')[0]}`);
      console.log(`Route Time Window: ${routeStartTime} - ${routeEndTime}`);
      console.log(`${'='.repeat(80)}\n`);
      
      // Fetch raw route hotspot rows from DB
      const rawRows = await prisma.$queryRawUnsafe(
        `SELECT 
          route_hotspot_ID,
          hotspot_order,
          item_type,
          hotspot_ID,
          hotspot_start_time,
          hotspot_end_time,
          is_conflict,
          conflict_reason
        FROM dvi_itinerary_route_hotspot_details
        WHERE itinerary_plan_ID = ? AND itinerary_route_ID = ? AND deleted = 0 AND status = 1
        ORDER BY hotspot_order ASC, item_type ASC`,
        planId,
        routeId
      ) as any[];
      
      console.log(`[RawDBRows] Fetched ${rawRows.length} hotspot rows\n`);
      
      // Log raw DB state
      console.log('[SegmentChronology][PROOF] Raw DB row order:');
      for (const row of rawRows) {
        const startTime = formatTime((row as any).hotspot_start_time);
        const endTime = formatTime((row as any).hotspot_end_time);
        const startMins = timeToMinutes(startTime);
        const endMins = timeToMinutes(endTime);
        
        const itemTypeLabel = getItemTypeLabel((row as any).item_type);
        
        console.log(
          `  [Order=${String((row as any).hotspot_order).padStart(3)}] Type=${itemTypeLabel.padEnd(15)} ` +
          `Time=${startTime} - ${endTime}  ` +
          `HotspotID=${(row as any).hotspot_ID}  Conflict=${(row as any).is_conflict}`
        );
      }
      
      // Log route end violations
      console.log(`\n[RouteEndValidation][PROOF] Route end time: ${routeEndTime} (${timeToMinutes(routeEndTime)} min from midnight)`);
      const routeEndMins = timeToMinutes(routeEndTime || '');
      
      const violatingRows = rawRows.filter(row => {
        const endTime = formatTime((row as any).hotspot_end_time);
        const endMins = timeToMinutes(endTime || '');
        return endMins > routeEndMins;
      });
      
      if (violatingRows.length > 0) {
        console.log(`[RouteEndValidation][PROOF] ⚠️  ${violatingRows.length} rows EXCEED route end time:`);
        for (const row of violatingRows) {
          const startTime = formatTime((row as any).hotspot_start_time);
          const endTime = formatTime((row as any).hotspot_end_time);
          const endMins = timeToMinutes(endTime || '');
          const overageMins = endMins - routeEndMins;
          
          const itemTypeLabel = getItemTypeLabel((row as any).item_type);
          
          console.log(
            `    Type=${itemTypeLabel}  Time=${startTime} - ${endTime}  ` +
            `Exceeds by ${overageMins} min (ends at ${endMins}min vs route end ${routeEndMins}min)`
          );
        }
      } else {
        console.log(`[RouteEndValidation][PROOF] ✓ All rows within route end time`);
      }
      
      // Fetch hotspot masters to get names
      const hotspotIds = rawRows
        .map(r => (r as any).hotspot_ID)
        .filter(id => typeof id === 'number' && id > 0);
      
      const hotspotMasters = hotspotIds.length > 0
        ? await prisma.dvi_hotspot_place.findMany({
            where: {
              hotspot_ID: { in: hotspotIds },
              deleted: 0,
            },
          })
        : [];
      
      const hotspotMap = new Map(hotspotMasters.map(h => [h.hotspot_ID, h.hotspot_name]));
      
      // Fetch hotel for this route
      const hotelRow = await prisma.dvi_itinerary_plan_hotel_details.findFirst({
        where: {
          itinerary_plan_id: planId,
          itinerary_route_id: routeId,
          deleted: 0,
        },
      });
      
      let hotelName = 'Hotel';
      if (hotelRow) {
        const masterHotel = await prisma.dvi_hotel.findFirst({
          where: {
            hotel_id: hotelRow.hotel_id,
            deleted: false,
          },
        });
        
        if (masterHotel) {
          hotelName = masterHotel.hotel_name;
        }
      }
      
      // Analyze chronological ordering
      console.log(`\n[SegmentChronology][PROOF] Chronological analysis:`);
      
      const rowsWithTime = rawRows.map((row, idx) => ({
        ...row,
        dbIndex: idx,
        startMins: timeToMinutes(formatTime((row as any).hotspot_start_time) || ''),
        startTime: formatTime((row as any).hotspot_start_time),
        endMins: timeToMinutes(formatTime((row as any).hotspot_end_time) || ''),
        endTime: formatTime((row as any).hotspot_end_time),
        hotspotName: hotspotMap.get((row as any).hotspot_ID) || `Hotspot#${(row as any).hotspot_ID}`
      }));
      
      // Sort by actual chronological time
      const chronologicalOrder = [...rowsWithTime].sort((a, b) => (a as any).startMins - (b as any).startMins);
      
      console.log(`\n  DB Order (hotspot_order)          → Chronological Order (actual time):`);
      for (let i = 0; i < rawRows.length; i++) {
        const dbRow = rowsWithTime[i];
        const chronoRow = chronologicalOrder[i];
        const itemTypeLabel = getItemTypeLabel((dbRow as any).item_type);
        const chronoTypeLabel = getItemTypeLabel((chronoRow as any).item_type);
        
        const match = (dbRow as any).dbIndex === (chronoRow as any).dbIndex ? '✓' : '✗';
        
        console.log(
          `  ${match}  [DB] ${itemTypeLabel.padEnd(15)} ${(dbRow as any).startTime} → ` +
          `[CHR] ${chronoTypeLabel.padEnd(15)} ${(chronoRow as any).startTime}`
        );
      }
      
      // Detect specific misplaced travel + attraction pairs
      console.log(`\n[SegmentChronology][PROOF] Travel-Attraction pairs (should travel before attraction):`);
      
      for (let i = 0; i < rawRows.length; i++) {
        const row = rawRows[i];
        
        // Look for attractions (item_type=4)
        if ((row as any).item_type === 4) {
          const attractionName = hotspotMap.get((row as any).hotspot_ID) || `Hotspot#${(row as any).hotspot_ID}`;
          const attractionStartMins = timeToMinutes(formatTime((row as any).hotspot_start_time) || '');
          
          // Look backward for travel rows (item_type=3 or 5) with same/later hotspot_ID or destination
          for (let j = i - 1; j >= 0; j--) {
            const travelRow = rawRows[j];
            if ((travelRow as any).item_type === 3 || (travelRow as any).item_type === 5) {
              const travelEndMins = timeToMinutes(formatTime((travelRow as any).hotspot_end_time) || '');
              
              if (travelEndMins <= attractionStartMins) {
                const typeLabel = (travelRow as any).item_type === 3 ? 'TRAVEL_INTRA' : 'TRAVEL_TO_HOTEL';
                console.log(
                  `  ℹ️  ${typeLabel} ends at ${formatTime((travelRow as any).hotspot_end_time)} ` +
                  `→ ${attractionName} starts at ${formatTime((row as any).hotspot_start_time)} ` +
                  `(DB order: travel comes BEFORE attraction ✓)`
                );
                break;
              }
            }
          }
          
          // Look forward for travel rows that should have been before
          for (let j = i + 1; j < rawRows.length; j++) {
            const travelRow = rawRows[j];
            if (((travelRow as any).item_type === 3 || (travelRow as any).item_type === 5) && (travelRow as any).hotspot_ID === (row as any).hotspot_ID) {
              const travelStartMins = timeToMinutes(formatTime((travelRow as any).hotspot_start_time) || '');
              const travelEndMins = timeToMinutes(formatTime((travelRow as any).hotspot_end_time) || '');
              
              if (travelStartMins < attractionStartMins && travelEndMins <= attractionStartMins) {
                const typeLabel = (travelRow as any).item_type === 3 ? 'TRAVEL_INTRA' : 'TRAVEL_TO_HOTEL';
                console.log(
                  `  ⚠️  ${typeLabel} to ${attractionName} appears AFTER attraction in DB order!\n` +
                  `      Travel: ${formatTime((travelRow as any).hotspot_start_time)} - ${formatTime((travelRow as any).hotspot_end_time)}\n` +
                  `      Attraction: ${formatTime((row as any).hotspot_start_time)} - ${formatTime((row as any).hotspot_end_time)}`
                );
              }
            }
          }
        }
      }
      
      // Analyze hotel checkin anchoring
      console.log(`\n[HotelCheckinAnchor][PROOF] Hotel checkin timing analysis:`);
      
      const travelToHotelRow = rawRows.find(r => (r as any).item_type === 5);
      const checkinRow = rawRows.find(r => (r as any).item_type === 6);
      
      if (travelToHotelRow && checkinRow) {
        const travelStartMins = timeToMinutes(formatTime((travelToHotelRow as any).hotspot_start_time) || '');
        const travelEndMins = timeToMinutes(formatTime((travelToHotelRow as any).hotspot_end_time) || '');
        const checkinStartMins = timeToMinutes(formatTime((checkinRow as any).hotspot_start_time) || '');
        const checkinEndMins = timeToMinutes(formatTime((checkinRow as any).hotspot_end_time) || '');
        
        const travelStartTime = formatTime((travelToHotelRow as any).hotspot_start_time);
        const travelEndTime = formatTime((travelToHotelRow as any).hotspot_end_time);
        const checkinStartTime = formatTime((checkinRow as any).hotspot_start_time);
        const checkinEndTime = formatTime((checkinRow as any).hotspot_end_time);
        
        console.log(`  Travel to hotel: ${travelStartTime} - ${travelEndTime}`);
        console.log(`  Checkin time:    ${checkinStartTime} - ${checkinEndTime}`);
        
        // Check if checkin happens before travel ends
        if (checkinStartMins < travelEndMins) {
          const earlyByMins = travelEndMins - checkinStartMins;
          console.log(
            `  ⚠️  ISSUE: Checkin at ${checkinStartTime} is ${earlyByMins} min BEFORE ` +
            `hotel arrival (${travelEndTime})`
          );
          console.log(`      Checkin should occur at or after travel completion`);
        } else if (checkinStartMins === travelEndMins) {
          console.log(
            `  ⚠️  ISSUE: Checkin at ${checkinStartTime} is AT travel start time, ` +
            `not arrival time (${travelEndTime})`
          );
        } else {
          const lateByMins = checkinStartMins - travelEndMins;
          console.log(`  ✓ Checkin at ${checkinStartTime} is ${lateByMins} min after arrival ✓`);
        }
      } else {
        console.log(`  ℹ️  Travel to hotel: ${travelToHotelRow ? 'found' : 'NOT FOUND'}`);
        console.log(`  ℹ️  Checkin row:     ${checkinRow ? 'found' : 'NOT FOUND'}`);
      }
    }
    
    // Now fetch and analyze the actual API response
    console.log(`\n\n${'='.repeat(80)}`);
    console.log('FETCHING LIVE API RESPONSE');
    console.log(`${'='.repeat(80)}\n`);
    
    const apiUrl = `${API_BASE_URL}/api/v1/itineraries/details/${QUOTE_ID}`;
    console.log(`[APICall] Requesting: ${apiUrl}`);
    
    let apiData: any;
    try {
      const response = await axios.get(apiUrl);
      apiData = response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      console.error(`API Error: ${axiosError.response?.status} - ${axiosError.message}`);
      process.exit(1);
    }
    
    // Analyze each day's segments
    for (let dayIdx = 0; dayIdx < apiData.days.length; dayIdx++) {
      const day = apiData.days[dayIdx];
      const dayNumber = dayIdx + 1;
      
      console.log(`\n${'='.repeat(80)}`);
      console.log(`DAY ${dayNumber} | Segments in API Response`);
      console.log(`${'='.repeat(80)}\n`);
      
      console.log(`[APIResponse] Start time: ${day.startTime} | End time: ${day.endTime}\n`);
      
      const segments = day.segments || [];
      
      console.log('[SegmentChronology][PROOF] API Response segment order:');
      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const seg = segments[segIdx];
        const timeRange = seg.timeRange ? ` [${seg.timeRange}]` : '';
        
        let segLabel = '';
        if (seg.type === 'start') {
          segLabel = 'START';
        } else if (seg.type === 'travel') {
          segLabel = `TRAVEL (${seg.from} → ${seg.to})`;
        } else if (seg.type === 'attraction') {
          segLabel = `ATTRACTION (${seg.name})`;
        } else if (seg.type === 'checkin') {
          segLabel = `CHECKIN (${seg.hotelName})`;
        } else if (seg.type === 'break') {
          segLabel = `BREAK (${seg.location})`;
        } else if (seg.type === 'return') {
          segLabel = `RETURN`;
        } else if (seg.type === 'hotspot') {
          segLabel = `CTA (${seg.text})`;
        } else {
          segLabel = seg.type.toUpperCase();
        }
        
        console.log(`  [${String(segIdx).padStart(2)}] ${segLabel.padEnd(40)}${timeRange}`);
      }
      
      // Check for chronological violations in response
      console.log(`\n[SegmentChronology][PROOF] Chronological validation:`);
      
      let lastValidTime = 0;
      let violations = [];
      
      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const seg = segments[segIdx];
        
        if (!seg.timeRange) continue;
        
        const startMins = timeToMinutes(seg.timeRange.split(' - ')[0]);
        if (startMins < lastValidTime && startMins !== 0) {
          violations.push({
            segIdx,
            type: seg.type,
            timeRange: seg.timeRange,
            label: seg.type === 'travel' ? `${seg.from} → ${seg.to}` : (seg.name || seg.hotelName || ''),
            startMins,
            lastValidTime
          });
        }
        lastValidTime = Math.max(lastValidTime, startMins);
      }
      
      if (violations.length > 0) {
        console.log(`  ⚠️  Found ${violations.length} chronological violations:`);
        for (const v of violations) {
          console.log(
            `      [${v.segIdx}] ${v.type} at ${v.timeRange} (${v.startMins}min) ` +
            `appears after ${v.lastValidTime}min event`
          );
        }
      } else {
        console.log(`  ✓ All segments in chronological order`);
      }
      
      // Check for post-end violations
      console.log(`\n[RouteEndValidation][PROOF] Route end time in API: ${day.endTime}`);
      
      const routeEndMinsAPI = timeToMinutes(day.endTime || '00:00 AM');
      const postEndSegments = segments.filter(seg => {
        if (!seg.timeRange) return false;
        const timeStr = seg.timeRange.split(' - ')[1] || seg.timeRange;
        const endMins = timeToMinutes(timeStr);
        return endMins > routeEndMinsAPI;
      });
      
      if (postEndSegments.length > 0) {
        console.log(`  ⚠️  ${postEndSegments.length} segments EXCEED route end time (${day.endTime}):`);
        for (const seg of postEndSegments) {
          const segLabel = seg.type === 'travel' ? `${seg.from} → ${seg.to}` : (seg.name || seg.hotelName || '');
          console.log(`      ${seg.type.toUpperCase()} (${segLabel}): ${seg.timeRange}`);
        }
      } else {
        console.log(`  ✓ All segments within route end time`);
      }
      
      // Check hotel checkin timing in API
      const checkinSegment = segments.find(s => s.type === 'checkin');
      const travelToHotelSegment = segments.find(s => s.type === 'travel' && s.to && (s.to.includes('Hotel') || s.to === 'Hotel'));
      
      if (checkinSegment && travelToHotelSegment) {
        console.log(`\n[HotelCheckinAnchor][PROOF] Hotel timing in API response:`);
        console.log(`  Travel to hotel: ${travelToHotelSegment.timeRange}`);
        console.log(`  Checkin time:    ${checkinSegment.time}`);
        
        const travelEndTime = travelToHotelSegment.timeRange.split(' - ')[1];
        const travelEndMins = timeToMinutes(travelEndTime || '');
        const checkinMins = timeToMinutes(checkinSegment.time || '');
        
        if (checkinMins < travelEndMins) {
          const earlyByMins = travelEndMins - checkinMins;
          console.log(`  ⚠️  Checkin at ${checkinSegment.time} is ${earlyByMins}min BEFORE hotel arrival`);
        } else if (checkinMins === travelEndMins) {
          console.log(`  ⚠️  Checkin at ${checkinSegment.time} matches travel START time, not arrival`);
        } else {
          const afterByMins = checkinMins - travelEndMins;
          console.log(`  ✓ Checkin properly anchored ${afterByMins}min after arrival`);
        }
      }
    }
    
    console.log(`\n\n${'='.repeat(80)}`);
    console.log('INVESTIGATION COMPLETE');
    console.log(`${'='.repeat(80)}\n`);
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
