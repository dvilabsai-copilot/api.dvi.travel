const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.FIT_BASE_URL || 'http://127.0.0.1:4006';
const TOKEN = process.env.FIT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODI1ODkzNjcsImV4cCI6MTc4MzE5NDE2N30.o75Ap2L4ujmOJ9UKVrlJeiStqGPKWL5wjFjLJFnbYP8';
const PLAN_ID = Number(process.env.FIT_PLAN_ID || 9823);
const OUTPUT_DIR = path.resolve(__dirname, '..', 'tmp', 'fit-preview-9823');

const payloads = [
  {
    label: 'after_pamban_bridge',
    body: {
      routeId: 8171,
      selectedHotspotId: 41,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_ATTRACTION',
        anchorIndex: 6,
        anchorFrom: 'Pamban Bridge',
        anchorTo: 'Travel to Hotel',
        anchorLabel: 'After Pamban Bridge',
        anchorTimeRange: '05:15 PM - 05:30 PM',
        afterRowType: 'attraction',
        beforeRowType: 'travel',
        afterHotspotId: 40,
        afterRouteHotspotId: 142609,
        beforeHotspotId: null,
        beforeRouteHotspotId: null,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
  {
    label: 'after_alagar',
    body: {
      routeId: 8171,
      selectedHotspotId: 41,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_ATTRACTION',
        anchorIndex: 3,
        anchorFrom: 'Alagar Koyil &  Palamuthircholai Murugan Temple',
        anchorTo: 'Pamban Bridge',
        anchorLabel: 'After Alagar Koyil &  Palamuthircholai Murugan Temple',
        anchorTimeRange: '09:44 AM - 11:44 AM',
        afterRowType: 'attraction',
        beforeRowType: 'hotspot',
        afterHotspotId: 28,
        afterRouteHotspotId: 142590,
        beforeHotspotId: 40,
        beforeRouteHotspotId: 142609,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
  {
    label: 'before_first_attraction',
    body: {
      routeId: 8171,
      selectedHotspotId: 41,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_START',
        anchorIndex: 0,
        anchorFrom: 'Start Your Day',
        anchorTo: 'Alagar Koyil &  Palamuthircholai Murugan Temple',
        anchorLabel: 'Before first attraction: Alagar Koyil &  Palamuthircholai Murugan Temple',
        anchorTimeRange: '08:00 AM - 09:00 AM',
        afterRowType: 'start',
        beforeRowType: 'hotspot',
        afterHotspotId: null,
        afterRouteHotspotId: null,
        beforeHotspotId: 28,
        beforeRouteHotspotId: 142590,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
];

function isAttraction(row) {
  return String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
}

function hotspotIdOf(row) {
  return Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || row?.hotspot_id || row?.id || 0);
}

function rowName(row) {
  return String(row?.name || row?.text || row?.hotspot_name || `#${hotspotIdOf(row)}`).trim();
}

function summarizeTimeline(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    index,
    type: row?.type || row?.item_type || null,
    hotspotId: hotspotIdOf(row) || null,
    name: rowName(row),
    timeRange: row?.timeRange || row?.visitTime || null,
  }));
}

async function runOne(entry) {
  const url = `${BASE_URL}/api/v1/itineraries/${PLAN_ID}/manual-hotspot/fit-preview`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(entry.body),
  });

  const rawText = await response.text();
  let json = null;
  try {
    json = JSON.parse(rawText);
  } catch (error) {
    json = { parseError: String(error), rawText };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, `${entry.label}.json`),
    JSON.stringify(json, null, 2),
    'utf8',
  );

  const timeline = Array.isArray(json?.finalizedTimeline) ? json.finalizedTimeline : [];
  const attractions = timeline.filter(isAttraction).map((row) => ({
    hotspotId: hotspotIdOf(row),
    name: rowName(row),
    timeRange: row?.timeRange || row?.visitTime || null,
  }));

  const removed = Array.isArray(json?.removedHotspots) ? json.removedHotspots.map((row) => ({
    hotspotId: Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0) || null,
    name: String(row?.name || row?.hotspotName || row?.hotspot_name || '').trim(),
    reason: String(row?.reason || row?.message || '').trim(),
  })) : [];

  return {
    label: entry.label,
    status: response.status,
    code: json?.code || null,
    message: json?.message || null,
    resultType: json?.resultType || null,
    canConfirm: json?.canConfirm === true,
    acceptedReason: json?.acceptedReason || null,
    rejectedReasons: Array.isArray(json?.rejectedReasons) ? json.rejectedReasons : [],
    reasons: Array.isArray(json?.reasons) ? json.reasons : [],
    selectedOpeningConflict: json?.selectedOpeningConflict || null,
    attractions,
    removed,
    fullTimelineSummary: summarizeTimeline(timeline),
  };
}

async function main() {
  for (const entry of payloads) {
    const result = await runOne(entry);
    console.log(`\n=== ${result.label} ===`);
    console.log(JSON.stringify({
      status: result.status,
      code: result.code,
      message: result.message,
      resultType: result.resultType,
      canConfirm: result.canConfirm,
      acceptedReason: result.acceptedReason,
      rejectedReasons: result.rejectedReasons,
      reasons: result.reasons,
      selectedOpeningConflict: result.selectedOpeningConflict
        ? {
            hotspotName: result.selectedOpeningConflict.hotspotName || null,
            attemptedVisitTime: result.selectedOpeningConflict.attemptedVisitTime || null,
            operatingHours: result.selectedOpeningConflict.operatingHours || null,
          }
        : null,
      attractions: result.attractions,
      removed: result.removed,
    }, null, 2));
  }

  console.log(`\nSaved raw responses to ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
