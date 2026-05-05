/*
  Dev audit script: manual hotspot insertion scoring snapshot.
  Usage:
    node scripts/audit/manual-hotspot-insertion-score.js <planId> <routeId> <manualHotspotIdsCsv>

  Example:
    node scripts/audit/manual-hotspot-insertion-score.js 123 456 889,901
*/

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return +(R * c).toFixed(2);
}

function timeToMinutes(dateLike) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (!Number.isFinite(d.getTime())) return null;
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function distance(masterMap, a, b) {
  if (!a || !b || a === b) return 0;
  const ma = masterMap.get(Number(a));
  const mb = masterMap.get(Number(b));
  const aLat = Number(ma?.hotspot_latitude);
  const aLng = Number(ma?.hotspot_longitude);
  const bLat = Number(mb?.hotspot_latitude);
  const bLng = Number(mb?.hotspot_longitude);
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return 0;
  return haversineKm(aLat, aLng, bLat, bLng);
}

function scoreCandidate(payload) {
  return (
    payload.waitingMinutes * 20 +
    payload.extraTravelKm * 10 +
    payload.totalTravelKm * 2 +
    payload.toAndFroPenalty * 100 +
    payload.removedOptionalCount * 200 +
    payload.topPriorityAffectedCount * 100000 +
    payload.routeEndOverflowMinutes * 1000 +
    payload.openingHourConflictCount * 5000
  );
}

async function main() {
  const planId = Number(process.argv[2]);
  const routeId = Number(process.argv[3]);
  const manualIds = String(process.argv[4] || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!planId || !routeId || manualIds.length === 0) {
    console.error("Usage: node scripts/audit/manual-hotspot-insertion-score.js <planId> <routeId> <manualHotspotIdsCsv>");
    process.exit(1);
  }

  const route = await prisma.dvi_itinerary_route_details.findFirst({
    where: { itinerary_plan_ID: planId, itinerary_route_ID: routeId, deleted: 0 },
    select: {
      route_start_time: true,
      route_end_time: true,
      location_name: true,
      next_visiting_location: true,
      itinerary_route_date: true,
    },
  });

  const rows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: {
      itinerary_plan_ID: planId,
      itinerary_route_ID: routeId,
      deleted: 0,
      item_type: { in: [2, 3, 4, 5, 6] },
    },
    orderBy: [{ hotspot_start_time: "asc" }, { hotspot_order: "asc" }, { route_hotspot_ID: "asc" }],
  });

  const hotspotIds = Array.from(new Set(rows.map((r) => Number(r.hotspot_ID || 0)).concat(manualIds))).filter((n) => n > 0);

  const masters = hotspotIds.length
    ? await prisma.dvi_hotspot_place.findMany({
        where: { hotspot_ID: { in: hotspotIds } },
        select: {
          hotspot_ID: true,
          hotspot_name: true,
          hotspot_priority: true,
          hotspot_latitude: true,
          hotspot_longitude: true,
        },
      })
    : [];

  const masterMap = new Map(masters.map((m) => [Number(m.hotspot_ID), m]));

  const attractions = rows
    .filter((r) => Number(r.item_type) === 4)
    .map((r) => ({
      hotspotId: Number(r.hotspot_ID || 0),
      order: Number(r.hotspot_order || 0),
      start: timeToMinutes(r.hotspot_start_time),
      end: timeToMinutes(r.hotspot_end_time),
      priority: Number(masterMap.get(Number(r.hotspot_ID || 0))?.hotspot_priority || 0),
      name: String(masterMap.get(Number(r.hotspot_ID || 0))?.hotspot_name || `Hotspot #${r.hotspot_ID}`),
    }))
    .filter((r) => r.hotspotId > 0)
    .sort((a, b) => (a.start ?? 9999) - (b.start ?? 9999));

  const baseSequence = attractions.map((a) => a.hotspotId);

  console.log("\n[ManualInsertionAudit] current route sequence");
  console.table(
    attractions.map((a, idx) => ({
      idx,
      hotspotId: a.hotspotId,
      name: a.name,
      priority: a.priority,
      order: a.order,
      start: a.start,
      end: a.end,
    })),
  );

  const candidates = [];
  for (let pos = 0; pos <= baseSequence.length; pos += 1) {
    const seq = [...baseSequence];
    seq.splice(pos, 0, ...manualIds);

    let totalTravelKm = 0;
    for (let i = 1; i < seq.length; i += 1) {
      totalTravelKm += distance(masterMap, seq[i - 1], seq[i]);
    }

    let extraTravelKm = 0;
    for (const mid of manualIds) {
      const idx = seq.findIndex((id) => Number(id) === Number(mid));
      if (idx <= 0 || idx >= seq.length - 1) continue;
      const prev = seq[idx - 1];
      const next = seq[idx + 1];
      const d = distance(masterMap, prev, mid) + distance(masterMap, mid, next) - distance(masterMap, prev, next);
      if (d > 0) extraTravelKm += d;
    }

    const waitingMinutes = 0; // read-only approximation script; engine computes exact waiting via timeline simulation
    const toAndFroPenalty = extraTravelKm >= 20 ? 1 : 0;

    const score = scoreCandidate({
      waitingMinutes,
      extraTravelKm,
      totalTravelKm,
      toAndFroPenalty,
      removedOptionalCount: 0,
      topPriorityAffectedCount: 0,
      routeEndOverflowMinutes: 0,
      openingHourConflictCount: 0,
    });

    candidates.push({
      candidateIndex: pos,
      positionLabel: pos === 0 ? "before-first-attraction" : (pos === baseSequence.length ? "before-hotel-drop" : `after-attraction-${pos}`),
      waitingMinutes,
      extraTravelKm: Number(extraTravelKm.toFixed(2)),
      totalTravelKm: Number(totalTravelKm.toFixed(2)),
      toAndFroPenalty,
      removedOptionalCount: 0,
      topPriorityAffectedCount: 0,
      score,
    });
  }

  const selected = [...candidates].sort((a, b) => a.score - b.score)[0] || null;

  console.log("\n[ManualInsertionAudit] candidate positions");
  console.table(candidates);

  console.log("\n[ManualInsertionAudit] selected candidate");
  console.log(selected);

  console.log("\n[ManualInsertionAudit] context");
  console.log({
    planId,
    routeId,
    manualIds,
    routeStartTime: route?.route_start_time || null,
    routeEndTime: route?.route_end_time || null,
    note: "This script is read-only and approximate. The service optimizer performs full simulation with waiting/opening-hour checks.",
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
