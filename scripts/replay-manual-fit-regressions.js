const http = require('http');

const AUTH_TOKEN =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4';

const cases = [
  {
    id: 'munnar-before-oottupura',
    planId: 9825,
    payload: {
      routeId: 8153,
      selectedHotspotId: 898,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_START',
        anchorIndex: 0,
        anchorFrom: 'Start your Journey',
        anchorTo: 'Oottupura Restaurant',
        anchorLabel: 'Before first attraction: Oottupura Restaurant',
        anchorTimeRange: '08:00 AM - 09:00 AM',
        afterRowType: 'start',
        beforeRowType: 'hotspot',
        afterHotspotId: null,
        afterRouteHotspotId: null,
        beforeHotspotId: 899,
        beforeRouteHotspotId: 128365,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
  {
    id: 'munnar-after-oottupura',
    planId: 9825,
    payload: {
      routeId: 8153,
      selectedHotspotId: 898,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_ATTRACTION',
        anchorIndex: 4,
        anchorFrom: 'Oottupura Restaurant',
        anchorTo: 'Clay Oven Resturant',
        anchorLabel: 'After Oottupura Restaurant',
        anchorTimeRange: '12:00 PM - 12:45 PM',
        afterRowType: 'attraction',
        beforeRowType: 'hotspot',
        afterHotspotId: 899,
        afterRouteHotspotId: 128365,
        beforeHotspotId: 596,
        beforeRouteHotspotId: 128372,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
  {
    id: 'munnar-after-clay-oven',
    planId: 9825,
    payload: {
      routeId: 8153,
      selectedHotspotId: 898,
      anchor: {
        anchorType: 'BETWEEN_ROWS',
        anchorIntent: 'AFTER_ATTRACTION',
        anchorIndex: 7,
        anchorFrom: 'Clay Oven Resturant',
        anchorTo: 'Cheeyappara Waterfalls',
        anchorLabel: 'After Clay Oven Resturant',
        anchorTimeRange: '02:07 PM - 02:37 PM',
        afterRowType: 'attraction',
        beforeRowType: 'hotspot',
        afterHotspotId: 596,
        afterRouteHotspotId: 128372,
        beforeHotspotId: 228,
        beforeRouteHotspotId: 128377,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
  {
    id: 'apj-after-pamban-yesterday',
    planId: 9823,
    payload: {
      routeId: 8175,
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
        afterRouteHotspotId: 147208,
        beforeHotspotId: null,
        beforeRouteHotspotId: null,
      },
      allowP3Removal: true,
      allowP1P2Removal: true,
    },
  },
];

function requestCase(testCase) {
  const body = JSON.stringify(testCase.payload);
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4006,
        path: `/api/v1/itineraries/${testCase.planId}/manual-hotspot/fit-preview`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: AUTH_TOKEN,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            resolve({ ok: true, status: res.statusCode, json });
          } catch (error) {
            resolve({
              ok: false,
              status: res.statusCode,
              error: `JSON parse failed: ${error.message}`,
              raw,
            });
          }
        });
      },
    );

    req.on('error', (error) => {
      resolve({ ok: false, status: 0, error: error.message, raw: '' });
    });

    req.write(body);
    req.end();
  });
}

function getHotspotId(row) {
  return Number(
    row?.hotspotId ||
      row?.hotspot_ID ||
      row?.locationId ||
      row?.hotspot_id ||
      row?.id ||
      0,
  );
}

function isAttraction(row) {
  return String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
}

function summarizeResponse(testCase, result) {
  if (!result.ok) {
    return {
      id: testCase.id,
      status: result.status,
      ok: false,
      error: result.error,
      rawPreview: String(result.raw || '').slice(0, 400),
    };
  }

  const response = result.json;
  const finalizedTimeline = Array.isArray(response.finalizedTimeline) ? response.finalizedTimeline : [];
  const finalizedAttractions = finalizedTimeline.filter(isAttraction);
  const removedItems = Array.isArray(response?.changesRequiredDisplay?.removedItems)
    ? response.changesRequiredDisplay.removedItems
    : [];

  return {
    id: testCase.id,
    status: result.status,
    ok: true,
    resultType: response.resultType,
    canConfirm: response.canConfirm,
    selectedHotspotPreserved:
      response.selectedHotspotPreserved ?? response?.manualInsertionFit?.selectedHotspotPreserved ?? null,
    selectedAnchorPreserved:
      response.selectedAnchorPreserved ?? response?.manualInsertionFit?.selectedAnchorPreserved ?? null,
    exactAnchorDrift: response?.manualInsertionFit?.exactAnchorDrift ?? null,
    selectedOpeningConflict: response?.selectedOpeningConflict?.reason || null,
    removedItems: removedItems.map((row) => ({
      hotspotId: Number(row?.hotspotId || 0),
      name: row?.name || null,
      reason: row?.reason || row?.fitFailureExplanation || null,
      code: row?.removalReasonCode || null,
    })),
    finalizedAttractions: finalizedAttractions.map((row) => ({
      hotspotId: getHotspotId(row),
      name: row?.name || row?.text || null,
      timeRange: row?.timeRange || null,
      operatingHours: row?.operatingHours || row?.timings || null,
      isSelected: getHotspotId(row) === Number(testCase.payload.selectedHotspotId),
      conflictReason: row?.conflictReason || row?.conflict_reason || null,
    })),
  };
}

async function main() {
  const summaries = [];

  for (const testCase of cases) {
    const result = await requestCase(testCase);
    summaries.push(summarizeResponse(testCase, result));
  }

  console.log(JSON.stringify(summaries, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
