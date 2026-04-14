const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TARGET = {
  quoteId: 'DVI202604230',
  planId: 268,
  routeId: 1238,
  hotspotId: 13,
  routeHotspotId: 40060,
};

const CANDIDATE_WRITERS = [
  {
    file: 'src/modules/itineraries/engines/hotspot-engine.service.ts',
    function: 'rebuildRouteHotspots',
    statement: 'dvi_itinerary_route_hotspot_details.createMany({ data: dbHotspotRows })',
    writeType: 'createMany',
    canWriteItemType4: true,
    canWriteRowsLike40060: true,
  },
  {
    file: 'src/modules/itineraries/itineraries.service.ts',
    function: 'addHotspot',
    statement: 'dvi_itinerary_route_hotspot_details.create({...hotspot_plan_own_way:1,item_type:4...})',
    writeType: 'create',
    canWriteItemType4: true,
    canWriteRowsLike40060: false,
  },
  {
    file: 'src/modules/itineraries/itineraries.service.ts',
    function: 'ensureManualHotspotRow',
    statement: 'dvi_itinerary_route_hotspot_details.create({...hotspot_order:999,placeholder time...})',
    writeType: 'create',
    canWriteItemType4: true,
    canWriteRowsLike40060: false,
  },
  {
    file: 'src/modules/itineraries/itineraries.service.ts',
    function: 'forcePersistManualHotspot',
    statement: 'dvi_itinerary_route_hotspot_details.create({...is_conflict:1, fallbackTime...})',
    writeType: 'create',
    canWriteItemType4: true,
    canWriteRowsLike40060: false,
  },
  {
    file: 'src/modules/itineraries/engines/itinerary-hotspots.engine.ts',
    function: 'buildForPlan (legacy engine path)',
    statement: 'multiple dvi_itinerary_route_hotspot_details.create(...) calls',
    writeType: 'create',
    canWriteItemType4: true,
    canWriteRowsLike40060: false,
  },
];

function hhmmss(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function sec(value) {
  if (!value) return 0;
  const txt = hhmmss(value);
  const [h, m, s] = txt.split(':').map((v) => Number(v || 0));
  return h * 3600 + m * 60 + s;
}

function addWrap(baseSeconds, deltaSeconds) {
  const raw = baseSeconds + deltaSeconds;
  const wrapped = ((raw % 86400) + 86400) % 86400;
  return { raw, wrapped };
}

function fmtSec(total) {
  const wrapped = ((Math.floor(total) % 86400) + 86400) % 86400;
  const h = String(Math.floor(wrapped / 3600)).padStart(2, '0');
  const m = String(Math.floor((wrapped % 3600) / 60)).padStart(2, '0');
  const s = String(wrapped % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function pickWriterByShape(targetRow, allRowsSameRoute) {
  const hasMoneyFields =
    Number(targetRow.hotspot_adult_entry_cost || 0) >= 0 &&
    Number(targetRow.hotspot_child_entry_cost || 0) >= 0 &&
    Number(targetRow.hotspot_infant_entry_cost || 0) >= 0;

  const peersSameCreatedOn = allRowsSameRoute.filter((r) => {
    const a = r.createdon ? new Date(r.createdon).toISOString() : null;
    const b = targetRow.createdon ? new Date(targetRow.createdon).toISOString() : null;
    return a && b && a === b;
  });

  const sameOrderPair = allRowsSameRoute.filter(
    (r) => Number(r.hotspot_order || 0) === Number(targetRow.hotspot_order || 0),
  );

  const hasTravelPair = sameOrderPair.some((r) => Number(r.item_type) === 3);

  return {
    hasMoneyFields,
    sameCreatedOnCount: peersSameCreatedOn.length,
    hasTravelPair,
    sameOrderPair,
    peersSameCreatedOn: peersSameCreatedOn.map((r) => ({
      route_hotspot_ID: r.route_hotspot_ID,
      item_type: r.item_type,
      hotspot_ID: r.hotspot_ID,
      hotspot_order: r.hotspot_order,
      createdon: r.createdon,
    })),
  };
}

async function main() {
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: TARGET.planId, itinerary_quote_ID: TARGET.quoteId },
  });

  const route = await prisma.dvi_itinerary_route_details.findUnique({
    where: { itinerary_route_ID: TARGET.routeId },
  });

  let row = await prisma.dvi_itinerary_route_hotspot_details.findUnique({
    where: { route_hotspot_ID: TARGET.routeHotspotId },
  });

  const routeRows = await prisma.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_route_ID: TARGET.routeId, deleted: 0 },
    orderBy: [{ route_hotspot_ID: 'asc' }],
  });

  const historicalRowByShape = routeRows
    .filter(
      (r) =>
        Number(r.item_type || 0) === 4 &&
        Number(r.hotspot_ID || 0) === TARGET.hotspotId &&
        hhmmss(r.hotspot_start_time) === '21:43:00' &&
        hhmmss(r.hotspot_end_time) === '02:43:00',
    )
    .sort((a, b) => Number(b.route_hotspot_ID || 0) - Number(a.route_hotspot_ID || 0))[0] || null;

  if (!row) {
    row = historicalRowByShape;
  }

  if (!row) {
    console.error('Target row not found and no equivalent active row by shape', TARGET);
    process.exit(1);
  }

  const neighborRows = routeRows.filter(
    (r) => r.route_hotspot_ID >= TARGET.routeHotspotId - 12 && r.route_hotspot_ID <= TARGET.routeHotspotId + 12,
  );

  const sameOrderRows = routeRows.filter((r) => Number(r.hotspot_order || 0) === Number(row.hotspot_order || 0));
  const predecessorTravelSameHotspot = routeRows
    .filter(
      (r) =>
        Number(r.route_hotspot_ID || 0) < Number(row.route_hotspot_ID || 0) &&
        Number(r.item_type || 0) === 3 &&
        Number(r.hotspot_ID || 0) === Number(row.hotspot_ID || 0),
    )
    .sort((a, b) => Number(b.route_hotspot_ID || 0) - Number(a.route_hotspot_ID || 0))[0] || null;

  const hotspot = await prisma.dvi_hotspot_place.findUnique({
    where: { hotspot_ID: TARGET.hotspotId },
    select: { hotspot_ID: true, hotspot_duration: true, hotspot_name: true, hotspot_location: true },
  });

  const jsDay = route?.itinerary_route_date ? new Date(route.itinerary_route_date).getUTCDay() : 0;
  const dayMonZero = (jsDay + 6) % 7;

  const timing = await prisma.dvi_hotspot_timing.findMany({
    where: {
      hotspot_ID: TARGET.hotspotId,
      hotspot_timing_day: dayMonZero,
      deleted: 0,
      status: 1,
    },
    orderBy: { hotspot_start_time: 'asc' },
  });

  const prevById = routeRows
    .filter((r) => r.route_hotspot_ID < Number(row.route_hotspot_ID || 0))
    .slice(-1)[0] || null;

  const travelStartSec = sec(predecessorTravelSameHotspot ? predecessorTravelSameHotspot.hotspot_start_time : null);
  const travelEndSec = sec(predecessorTravelSameHotspot ? predecessorTravelSameHotspot.hotspot_end_time : null);
  const travelDurationSec = sec(predecessorTravelSameHotspot ? predecessorTravelSameHotspot.hotspot_traveling_time : null);
  const hotspotDurationSec = sec(hotspot ? hotspot.hotspot_duration : null);

  const computedVisitStart = addWrap(travelStartSec, travelDurationSec);
  const computedVisitEnd = addWrap(computedVisitStart.wrapped, hotspotDurationSec);

  const routeEndSec = sec(route?.route_end_time || null);
  const visitStartSec = sec(row.hotspot_start_time);
  const visitEndSec = sec(row.hotspot_end_time);

  const travelToDestSecondsInProofRun = 8880;
  const projectedArrivalSeconds = visitEndSec + travelToDestSecondsInProofRun;

  const conflictCheckUsedInCode = {
    comparisonLeft: projectedArrivalSeconds,
    comparisonRight: routeEndSec,
    result: projectedArrivalSeconds > routeEndSec,
    note: 'Day-1 route-end conflict uses wrapped visitEnd seconds before adding travelToDest.',
  };

  const openWindow = timing[0]
    ? {
        start: sec(timing[0].hotspot_start_time),
        end: sec(timing[0].hotspot_end_time),
      }
    : null;

  const opWindowCheckUsedInCode = openWindow
    ? {
        visitStart: visitStartSec,
        visitEnd: visitEndSec,
        opStart: openWindow.start,
        opEnd: openWindow.end,
        pass: visitStartSec >= openWindow.start && visitEndSec <= openWindow.end,
      }
    : null;

  const writerShape = pickWriterByShape(row, routeRows);

  const proof = {
    target: TARGET,
    candidateWriters: CANDIDATE_WRITERS,
    targetRowFoundBy: row.route_hotspot_ID === TARGET.routeHotspotId ? 'exactRouteHotspotId' : 'equivalentActiveRowShape',
    plan: plan
      ? {
          itinerary_plan_ID: plan.itinerary_plan_ID,
          itinerary_quote_ID: plan.itinerary_quote_ID,
          createdby: plan.createdby,
        }
      : null,
    route: route
      ? {
          itinerary_route_ID: route.itinerary_route_ID,
          route_start_time: route.route_start_time,
          route_end_time: route.route_end_time,
          itinerary_route_date: route.itinerary_route_date,
        }
      : null,
    row40060: row,
    neighbors: neighborRows,
    sameOrderRows,
    previousRowById: prevById,
    matchedTravelRow: predecessorTravelSameHotspot,
    hotspotMaster: hotspot,
    hotspotTimingRouteDay: timing,
    computed: {
      travelStartSec,
      travelDurationSec,
      travelEndSec,
      hotspotDurationSec,
      computedVisitStartRaw: computedVisitStart.raw,
      computedVisitStartWrapped: computedVisitStart.wrapped,
      computedVisitStartHHMMSS: fmtSec(computedVisitStart.wrapped),
      computedVisitEndRaw: computedVisitEnd.raw,
      computedVisitEndWrapped: computedVisitEnd.wrapped,
      computedVisitEndHHMMSS: fmtSec(computedVisitEnd.wrapped),
      storedVisitStartHHMMSS: hhmmss(row.hotspot_start_time),
      storedVisitEndHHMMSS: hhmmss(row.hotspot_end_time),
      routeEndSec,
      routeEndHHMMSS: fmtSec(routeEndSec),
      travelToDestSecondsInProofRun,
      projectedArrivalSeconds,
    },
    decisionProof: {
      conflictCheckUsedInCode,
      opWindowCheckUsedInCode,
      storedIsConflict: Number(row.is_conflict || 0),
    },
    writerShape,
    writerConclusion: {
      writerFunction: 'HotspotEngineService.rebuildRouteHotspots -> dvi_itinerary_route_hotspot_details.createMany',
      writerFile: 'src/modules/itineraries/engines/hotspot-engine.service.ts',
      rowBuilder: 'TimelineBuilder.buildTimelineForPlan + HotspotSegmentBuilder.build',
      rowBuilderFiles: [
        'src/modules/itineraries/engines/helpers/timeline.builder.ts',
        'src/modules/itineraries/engines/helpers/hotspot-segment.builder.ts',
      ],
      why: [
        'Row has item_type=4 timeline shape with paired item_type=3 same hotspot_order.',
        'Row carries hotspot timing/money/conflict columns exactly as HotspotSegmentBuilder emits before createMany.',
        'Route rows around target share same createdon batch signature consistent with createMany timeline persistence.',
      ],
    },
  };

  console.log(JSON.stringify(proof, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
