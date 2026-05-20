#!/usr/bin/env node
/*
  Manual hotspot preview diagnostic
  Usage:
    node scripts/manual-hotspot-preview-diagnostic.js --plan 292 --route 2843 --hotspot 8 --anchorType after_travel --anchorIndex 0

  Required env:
    AUTH_TOKEN=<jwt>

  Optional env:
    API_BASE_URL=http://127.0.0.1:4006/api/v1
*/

const { PrismaClient } = require('@prisma/client');

function parseArg(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function asInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return Math.trunc(n);
}

function toHm(dateLike) {
  if (!dateLike) return 'N/A';
  const d = new Date(dateLike);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

(async function main() {
  const token = process.env.AUTH_TOKEN;
  if (!token) {
    throw new Error('Missing AUTH_TOKEN env var');
  }

  const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
  const planId = asInt(parseArg('plan'), 'plan');
  const routeId = asInt(parseArg('route'), 'route');
  const hotspotId = asInt(parseArg('hotspot'), 'hotspot');
  const anchorType = parseArg('anchorType', 'after_travel');
  const anchorIndex = asInt(parseArg('anchorIndex', '0'), 'anchorIndex');

  const payload = {
    routeId,
    hotspotId,
    anchorType,
    anchorIndex,
  };

  console.log('=== Request ===');
  console.log(`${apiBase}/itineraries/${planId}/manual-hotspot/preview`);
  console.log(JSON.stringify(payload));

  const res = await fetch(`${apiBase}/itineraries/${planId}/manual-hotspot/preview`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw
  }

  console.log('\n=== Response ===');
  console.log(`status=${res.status}`);
  if (!data) {
    console.log(text.slice(0, 2000));
    process.exit(1);
  }

  const timeline = Array.isArray(data.fullTimeline) ? data.fullTimeline : [];
  const selected = timeline.find(
    (seg) => Number(seg?.item_type) === 4 && Number(seg?.hotspot_ID) === hotspotId,
  );

  console.log('anchorPreference=', JSON.stringify(data.anchorPreference || null));
  console.log('resolution=', JSON.stringify(data.resolution || null));

  console.log('\n=== Selected Hotspot In Preview ===');
  if (!selected) {
    console.log('NOT FOUND in fullTimeline');
  } else {
    console.log({
      text: selected.text,
      timeRange: selected.timeRange,
      isConflict: selected.isConflict,
      conflictReason: selected.conflictReason,
      startRaw: selected.hotspot_start_time,
      endRaw: selected.hotspot_end_time,
    });
  }

  console.log('\n=== Route Timeline (item_type=4 visits) ===');
  const visitRows = timeline
    .filter((r) => Number(r?.itinerary_route_ID) === routeId && Number(r?.item_type) === 4)
    .map((r) => ({
      hotspotId: r.hotspot_ID,
      name: r.text,
      timeRange: r.timeRange,
      isConflict: !!r.isConflict,
    }));
  console.table(visitRows);

  const prisma = new PrismaClient();
  try {
    const dbRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_plan_ID: planId,
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_order: true,
        hotspot_start_time: true,
        hotspot_end_time: true,
      },
      orderBy: [
        { hotspot_order: 'asc' },
        { route_hotspot_ID: 'asc' },
      ],
    });

    const ids = Array.from(new Set(dbRows.map((r) => Number(r.hotspot_ID || 0)).filter((id) => id > 0)));
    const masters = ids.length
      ? await prisma.dvi_hotspot_place.findMany({
          where: { hotspot_ID: { in: ids } },
          select: {
            hotspot_ID: true,
            hotspot_name: true,
            hotspot_priority: true,
          },
        })
      : [];
    const mMap = new Map(masters.map((m) => [Number(m.hotspot_ID), m]));

    console.log('\n=== DB Visits With Priority ===');
    const dbVisitReport = dbRows.map((r) => {
      const m = mMap.get(Number(r.hotspot_ID || 0));
      return {
        order: Number(r.hotspot_order || 0),
        hotspotId: Number(r.hotspot_ID || 0),
        name: m?.hotspot_name || 'Unknown',
        priority: Number(m?.hotspot_priority || 0),
        start: toHm(r.hotspot_start_time),
        end: toHm(r.hotspot_end_time),
      };
    });
    console.table(dbVisitReport);

    const removable = dbVisitReport
      .filter((r) => Number.isFinite(r.priority) && r.priority > 3)
      .sort((a, b) => {
        if (a.start !== b.start) return String(b.start).localeCompare(String(a.start));
        return Number(b.priority) - Number(a.priority);
      });

    console.log('\n=== Eviction Candidates (priority > 3) ===');
    console.table(removable);

    const fort = dbVisitReport.find((r) => /fort\s*st\.?\s*george/i.test(String(r.name)));
    if (fort) {
      console.log('\nFort St. George row:', fort);
      console.log(`Fort St. George removable=${fort.priority > 3}`);
    } else {
      console.log('\nFort St. George row not found in current route visits.');
    }
  } finally {
    await prisma.$disconnect();
  }
})();
