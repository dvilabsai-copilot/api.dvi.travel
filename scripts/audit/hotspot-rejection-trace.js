/**
 * Hotspot Rejection Trace Script
 * Usage: node scripts/audit/hotspot-rejection-trace.js [hotspotId] [quoteId]
 * Default: hotspotId=292, quoteId=DVI202604247
 *
 * Connects to DB via DATABASE_URL (from .env), pulls plan/route/timing state,
 * and explains why a given hotspotId was NOT scheduled (or shows it was).
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const TARGET_HOTSPOT_ID = Number(process.argv[2] || 292);
const QUOTE_ID = String(process.argv[3] || 'DVI202604247');

function parseDbUrl(url) {
  const m = String(url || '').match(/mysql:\/\/([^:]+):([^@]+)@([^:@/]+):(\d+)\/([^?]+)/);
  if (!m) throw new Error('DATABASE_URL not set or not a valid mysql:// URL');
  return {
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  };
}

function hmsToSeconds(val) {
  if (!val) return 0;
  const s = String(val);
  // Handle "HH:MM:SS" or Date object string
  const parts = s.split(':');
  if (parts.length >= 3) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return 0;
}

function toHMS(dateVal) {
  if (!dateVal) return 'null';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return String(dateVal);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function secondsToHMS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '??:??:??';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function dayOfWeekMonZero(dateStr) {
  // Convert route_date to Mon=0..Sun=6 (same as NestJS engine logic)
  const d = new Date(dateStr);
  return (d.getDay() + 6) % 7;
}

function logSection(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {
  const conn = await mysql.createConnection({ ...parseDbUrl(process.env.DATABASE_URL), dateStrings: false });

  logSection(`Hotspot Rejection Trace — hotspot ${TARGET_HOTSPOT_ID} on quote ${QUOTE_ID}`);

  // 1. Plan
  const [[plan]] = await conn.query(
    `SELECT itinerary_plan_ID, itinerary_quote_ID FROM dvi_itinerary_plan_details
     WHERE itinerary_quote_ID = ? AND deleted = 0 ORDER BY itinerary_plan_ID DESC LIMIT 1`,
    [QUOTE_ID]
  );
  if (!plan) {
    console.error(`No plan found for quote ${QUOTE_ID}`);
    process.exit(1);
  }
  console.log(`Plan ID: ${plan.itinerary_plan_ID}`);

  // 2. Master record
  const [[master]] = await conn.query(
    `SELECT hotspot_ID, hotspot_name, hotspot_priority, hotspot_latitude, hotspot_longitude,
            hotspot_location, status, deleted
     FROM dvi_hotspot_place WHERE hotspot_ID = ?`, [TARGET_HOTSPOT_ID]
  );
  logSection('Master Record');
  if (!master) {
    console.error(`❌ hotspot_place row NOT FOUND for hotspot_ID=${TARGET_HOTSPOT_ID}. Hotspot simply does not exist in DB.`);
    await conn.end(); return;
  }
  console.table([master]);
  if (Number(master.deleted) !== 0) {
    console.log(`❌ REJECTION REASON: hotspot_place.deleted = ${master.deleted} (soft-deleted from master)`);
  }
  if (Number(master.status) !== 1) {
    console.log(`❌ REJECTION REASON: hotspot_place.status = ${master.status} (not active)`);
  }

  // 3. Routes
  const [routes] = await conn.query(
    `SELECT itinerary_route_ID, itinerary_route_date, location_name, next_visiting_location,
            route_start_time, route_end_time, excluded_hotspot_ids
     FROM dvi_itinerary_route_details
     WHERE itinerary_plan_ID = ? AND deleted = 0
     ORDER BY itinerary_route_date ASC, itinerary_route_ID ASC`,
    [plan.itinerary_plan_ID]
  );
  logSection('Routes');
  console.table(routes.map(r => ({
    routeId: Number(r.itinerary_route_ID),
    date: r.itinerary_route_date ? new Date(r.itinerary_route_date).toISOString().split('T')[0] : '',
    from: String(r.location_name || '').split('|')[0].trim().substring(0, 25),
    to: String(r.next_visiting_location || '').split('|')[0].trim().substring(0, 25),
    routeStart: toHMS(r.route_start_time),
    routeEnd: toHMS(r.route_end_time),
    excludedIds: JSON.stringify(r.excluded_hotspot_ids || []).substring(0, 60),
  })));

  // 4. Check excluded list
  logSection(`Excluded hotspot check for ID ${TARGET_HOTSPOT_ID}`);
  for (const r of routes) {
    const excl = Array.isArray(r.excluded_hotspot_ids)
      ? r.excluded_hotspot_ids.map(Number)
      : (typeof r.excluded_hotspot_ids === 'string'
          ? JSON.parse(r.excluded_hotspot_ids || '[]').map(Number)
          : []);
    if (excl.includes(TARGET_HOTSPOT_ID)) {
      console.log(`⚠️  Route ${r.itinerary_route_ID} (${new Date(r.itinerary_route_date).toISOString().split('T')[0]}) has hotspot ${TARGET_HOTSPOT_ID} in excluded_hotspot_ids`);
    }
  }

  // 5. Persisted rows for this hotspot
  const [rows] = await conn.query(
    `SELECT h.route_hotspot_ID, h.itinerary_route_ID, h.item_type, h.hotspot_order,
            h.hotspot_start_time, h.hotspot_end_time, h.is_conflict, h.hotspot_plan_own_way, h.deleted
     FROM dvi_itinerary_route_hotspot_details h
     WHERE h.itinerary_plan_ID = ? AND h.hotspot_ID = ?`,
    [plan.itinerary_plan_ID, TARGET_HOTSPOT_ID]
  );
  logSection(`Persisted rows for hotspot ${TARGET_HOTSPOT_ID} (all states)`);
  if (!rows.length) {
    console.log(`❌ No rows at all in dvi_itinerary_route_hotspot_details for this hotspot. It was never scheduled into the plan.`);
  } else {
    console.table(rows.map(r => ({
      rowId: Number(r.route_hotspot_ID),
      routeId: Number(r.itinerary_route_ID),
      itemType: Number(r.item_type),
      order: Number(r.hotspot_order),
      start: toHMS(r.hotspot_start_time),
      end: toHMS(r.hotspot_end_time),
      isConflict: Number(r.is_conflict),
      isManual: Number(r.hotspot_plan_own_way),
      deleted: Number(r.deleted),
    })));

    // Explain per row
    for (const r of rows) {
      if (Number(r.deleted) === 1) {
        console.log(`  Row ${r.route_hotspot_ID}: deleted=1 → was scheduled but later soft-deleted (rebuild removed it)`);
      } else if (Number(r.is_conflict) === 1) {
        console.log(`  Row ${r.route_hotspot_ID}: is_conflict=1 → placed but marked conflict; excluded from final itinerary`);
      } else {
        console.log(`  Row ${r.route_hotspot_ID}: deleted=0, is_conflict=0 → currently ACTIVE in itinerary ✅`);
      }
    }
  }

  // 6. Timings for target hotspot
  logSection(`Timing records for hotspot ${TARGET_HOTSPOT_ID}`);
  const [timings] = await conn.query(
    `SELECT hotspot_timing_ID, hotspot_timing_day, hotspot_open_all_time,
            hotspot_start_time, hotspot_end_time, status, deleted
     FROM dvi_hotspot_timing WHERE hotspot_ID = ? AND deleted = 0`,
    [TARGET_HOTSPOT_ID]
  );

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (!timings.length) {
    console.log(`⚠️  No timing records found. Hotspot is treated as always open by the engine.`);
  } else {
    console.table(timings.map(t => ({
      timingId: Number(t.hotspot_timing_ID),
      day: `${t.hotspot_timing_day} (${DAY_NAMES[t.hotspot_timing_day] || '?'})`,
      openAllTime: Number(t.hotspot_open_all_time),
      open: toHMS(t.hotspot_start_time),
      close: toHMS(t.hotspot_end_time),
      status: Number(t.status),
    })));
  }

  // 7. Per-route timing vs route-window check
  logSection('Per-Route: Can hotspot fit within route window on that day?');
  for (const route of routes) {
    const routeId = Number(route.itinerary_route_ID);
    const dateStr = route.itinerary_route_date ? new Date(route.itinerary_route_date).toISOString().split('T')[0] : '';
    const dow = dayOfWeekMonZero(route.itinerary_route_date); // Mon=0
    const routeStartSec = hmsToSeconds(toHMS(route.route_start_time));
    const routeEndSec = hmsToSeconds(toHMS(route.route_end_time));

    const dayTimings = timings.filter(t => Number(t.hotspot_timing_day) === dow && Number(t.status) === 1);

    let openCheckResult = '✅ Open (no timings — treated as open)';
    if (dayTimings.length > 0) {
      const openAllTime = dayTimings.some(t => Number(t.hotspot_open_all_time) === 1);
      if (openAllTime) {
        openCheckResult = '✅ Open all day';
      } else {
        const fits = dayTimings.some(t => {
          const opStart = hmsToSeconds(toHMS(t.hotspot_start_time));
          const opEnd = hmsToSeconds(toHMS(t.hotspot_end_time));
          return routeStartSec < opEnd && routeEndSec > opStart;
        });
        openCheckResult = fits ? '✅ Fits within timing window' : `❌ CLOSED or does not fit window on ${DAY_NAMES[dow]}`;
      }
    } else if (timings.length > 0 && dayTimings.length === 0) {
      openCheckResult = `❌ CLOSED — no timing record for day ${dow} (${DAY_NAMES[dow]})`;
    }

    // How many attractions are already placed on this route?
    const [[countRow]] = await conn.query(
      `SELECT COUNT(*) as cnt FROM dvi_itinerary_route_hotspot_details
       WHERE itinerary_plan_ID = ? AND itinerary_route_ID = ? AND item_type = 4 AND deleted = 0 AND is_conflict = 0`,
      [plan.itinerary_plan_ID, routeId]
    );

    console.log(`Route ${routeId} (${dateStr}, DOW=${DAY_NAMES[dow]}): window=${secondsToHMS(routeStartSec)}-${secondsToHMS(routeEndSec)}, existingAttractions=${countRow.cnt}, timing=${openCheckResult}`);
  }

  // 8. Nearby hotspots on same route where hotspot 292 should logically fit
  logSection('Existing scheduled attractions (all active non-conflict rows)');
  const [activeAttractions] = await conn.query(
    `SELECT h.itinerary_route_ID, h.hotspot_ID, h.hotspot_order,
            h.hotspot_start_time, h.hotspot_end_time, hp.hotspot_name, hp.hotspot_priority
     FROM dvi_itinerary_route_hotspot_details h
     JOIN dvi_hotspot_place hp ON hp.hotspot_ID = h.hotspot_ID
     WHERE h.itinerary_plan_ID = ? AND h.item_type = 4 AND h.deleted = 0 AND h.is_conflict = 0
     ORDER BY h.itinerary_route_ID ASC, h.hotspot_order ASC`,
    [plan.itinerary_plan_ID]
  );
  console.table(activeAttractions.map(a => ({
    routeId: Number(a.itinerary_route_ID),
    hotspotId: Number(a.hotspot_ID),
    name: (String(a.hotspot_name || '')).substring(0, 30),
    priority: Number(a.hotspot_priority),
    order: Number(a.hotspot_order),
    start: toHMS(a.hotspot_start_time),
    end: toHMS(a.hotspot_end_time),
  })));

  // 9. Summary
  logSection('SUMMARY: Why hotspot 292 was rejected');
  const reasons = [];

  if (!master) reasons.push('Master record not found in dvi_hotspot_place');
  else {
    if (Number(master.deleted) !== 0) reasons.push(`master.deleted = ${master.deleted}`);
    if (Number(master.status) !== 1) reasons.push(`master.status = ${master.status} (not active)`);
  }

  for (const r of routes) {
    const excl = Array.isArray(r.excluded_hotspot_ids)
      ? r.excluded_hotspot_ids.map(Number)
      : (typeof r.excluded_hotspot_ids === 'string'
          ? (() => { try { return JSON.parse(r.excluded_hotspot_ids).map(Number); } catch { return []; } })()
          : []);
    if (excl.includes(TARGET_HOTSPOT_ID)) {
      reasons.push(`Route ${r.itinerary_route_ID}: in excluded_hotspot_ids (user or system excluded)`);
    }
  }

  const conflictRows = rows.filter(r => Number(r.is_conflict) === 1 && Number(r.deleted) === 0);
  const deletedRows = rows.filter(r => Number(r.deleted) === 1);
  const activeRows = rows.filter(r => Number(r.deleted) === 0 && Number(r.is_conflict) === 0);

  for (const r of conflictRows) {
    reasons.push(`Row ${r.route_hotspot_ID} (route ${r.itinerary_route_ID}): is_conflict=1 → cannot fit / time conflict`);
  }

  if (activeRows.length > 0) {
    console.log(`ℹ️  Hotspot ${TARGET_HOTSPOT_ID} HAS ACTIVE rows — it IS in the itinerary currently:`);
    activeRows.forEach(r => console.log(`   Route ${r.itinerary_route_ID}, start=${toHMS(r.hotspot_start_time)}, end=${toHMS(r.hotspot_end_time)}`));
    reasons.push(`NOTE: hotspot is currently ACTIVE (not rejected) — it appears in the scheduled itinerary`);
  } else if (reasons.length === 0) {
    reasons.push('No active rows found AND no obvious rejection cause detected. Likely never matched by HotspotSelector for this route (wrong location bucket, or all candidate slots exhausted before reaching this hotspot).');
  }

  reasons.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));

  await conn.end();
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
