const fs = require('fs');

function parseArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read JSON file at ${filePath}: ${error.message}`);
  }
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function findRemovedRow(response, pattern) {
  const rows = [
    ...toArray(response?.removedHotspots),
    ...toArray(response?.resolution?.removedHotspots),
    ...toArray(response?.resolution?.removedOptionalHotspots),
    ...toArray(response?.resolution?.removedTopPriorityHotspots),
    ...toArray(response?.resolution?.p3HotspotsToRemove),
  ];

  const seen = new Set();
  const deduped = rows.filter((row) => {
    const key = Number(row?.hotspotId || row?.id || 0) || String(row?.name || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const regex = pattern ? new RegExp(pattern, 'i') : /ramanatha/i;
  return {
    rows: deduped,
    target: deduped.find((row) => regex.test(String(row?.name || row?.hotspotName || row?.hotspot_name || ''))) || null,
  };
}

function getTimelineRows(response) {
  return toArray(response?.proposedTimeline);
}

function isAttractionRow(row) {
  const type = String(row?.type || '').trim().toLowerCase();
  const itemType = Number(row?.item_type || 0);
  return type === 'attraction' || type === 'hotspot' || itemType === 4;
}

function isTravelRow(row) {
  const type = String(row?.type || '').trim().toLowerCase();
  const itemType = Number(row?.item_type || 0);
  return type === 'travel' || itemType === 3;
}

function getHotspotId(row) {
  return Number(row?.hotspotId || row?.hotspot_ID || row?.locationId || row?.id || 0) || 0;
}

function getRowName(row) {
  return String(row?.name || row?.text || row?.hotspot_name || '').trim() || null;
}

function getRowTime(row) {
  return String(row?.timeRange || row?.visitTime || '').trim() || null;
}

function summarizeAttemptSequence(response) {
  const attemptLog = toArray(response?.attemptLog);
  return attemptLog
    .filter((row) => /^optimizer_attempt_/i.test(String(row?.id || '')))
    .map((row, index) => ({
      attempt: index + 1,
      label: row?.label || null,
      status: row?.status || null,
      message: row?.message || null,
      readyToApply: row?.details?.readyToApply ?? null,
      requiresConfirmation: row?.details?.requiresConfirmation ?? null,
    }));
}

function summarizeTimelineAroundAnchor(response, payload) {
  const timeline = getTimelineRows(response);
  const afterHotspotId = Number(payload?.anchor?.afterHotspotId || 0);
  const beforeHotspotId = Number(payload?.anchor?.beforeHotspotId || 0);

  const attractions = timeline
    .filter((row) => isAttractionRow(row) || isTravelRow(row))
    .map((row, index) => ({
      index,
      type: row?.type || null,
      hotspotId: getHotspotId(row),
      name: getRowName(row),
      time: getRowTime(row),
      isManual: row?.isManual === true,
    }));

  const afterIndex = attractions.findIndex((row) => row.hotspotId === afterHotspotId && row.type === 'attraction');
  const beforeIndex = attractions.findIndex((row) => row.hotspotId === beforeHotspotId && row.type === 'attraction');
  const manualIndex = attractions.findIndex((row) => row.isManual === true);

  return {
    afterHotspotId,
    beforeHotspotId,
    afterIndex,
    beforeIndex,
    manualIndex,
    rows: attractions.slice(Math.max(0, manualIndex - 3), Math.max(manualIndex + 4, 7)),
  };
}

function inferPrimaryBlocker(row, response) {
  if (!row) return 'UNKNOWN';

  const code = String(row?.removalReasonCode || '').trim();
  const resultType = String(response?.resultType || '');
  const summary = response?.removedPrioritySummary || {};

  if (code === 'ARRIVAL_AFTER_CLOSING' || code === 'VISIT_END_AFTER_CLOSING' || code === 'ARRIVAL_BEFORE_OPENING') {
    return 'OPENING_HOURS';
  }

  if (code === 'ROUTE_END_OVERFLOW' || Number(row?.routeEndOverflowMinutes || 0) > 0) {
    return 'ROUTE_END_OVERFLOW';
  }

  if (code === 'LOWER_PRIORITY_REMOVAL_REQUIRED' && Number(summary?.highestRemovedPriority || 0) >= 2) {
    return 'ANCHOR_PRESERVATION_OR_ROUTE_BUDGET';
  }

  if (resultType === 'FITS_WITH_OPTIONAL_REMOVAL') {
    return 'ROUTE_BUDGET_WITH_EXACT_ANCHOR';
  }

  return 'UNKNOWN';
}

function explainRule(row, response) {
  if (!row) return 'Target hotspot was not found in removed rows.';

  const code = String(row?.removalReasonCode || '').trim();
  const source = String(row?.attemptedVisitSource || '').trim() || 'NONE';
  const outsideMinutes = Number(row?.outsideOperatingMinutes || 0);
  const routeOverflow = Number(row?.routeEndOverflowMinutes || 0);
  const canConfirm = response?.canConfirm === true;
  const resultType = String(response?.resultType || '');

  if (code === 'ARRIVAL_AFTER_CLOSING' || code === 'VISIT_END_AFTER_CLOSING' || code === 'ARRIVAL_BEFORE_OPENING') {
    return `Removed due to operating-hours violation. Attempt source=${source}, outsideOperatingMinutes=${outsideMinutes}.`;
  }

  if (code === 'ROUTE_END_OVERFLOW' || routeOverflow > 0) {
    return `Removed because keeping it would overflow the route/day end by about ${routeOverflow} minute(s).`;
  }

  if (source === 'NONE') {
    return 'No attempted attraction visit exists in the recalculated preview timeline. This usually means the hotspot was removed before a valid attraction slot could be scheduled, so the rule is overall route-budget / anchor-preservation, not direct opening-hours failure.';
  }

  return `Hotspot still had a candidate attraction visit slot, but the preview classified the removal as overall route-budget / exact-anchor preservation. resultType=${resultType}, canConfirm=${canConfirm}.`;
}

function printSection(title, value) {
  console.log(`\n=== ${title} ===`);
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  console.dir(value, { depth: null, colors: true });
}

async function main() {
  const token = parseArg('token', process.env.FIT_PREVIEW_TOKEN || process.env.AUTH_TOKEN || '');
  const url = parseArg('url', process.env.FIT_PREVIEW_URL || 'http://127.0.0.1:4006/api/v1/itineraries/9706/manual-hotspot/fit-preview');
  const targetPattern = parseArg('target', process.env.FIT_PREVIEW_TARGET || 'ramanatha');
  const payloadFile = parseArg('payloadFile', process.env.FIT_PREVIEW_PAYLOAD_FILE || '');
  const outputFile = parseArg('outputFile', process.env.FIT_PREVIEW_OUTPUT_FILE || '');

  if (!token) {
    throw new Error('Missing token. Pass --token=... or set FIT_PREVIEW_TOKEN.');
  }

  const defaultPayload = {
    routeId: 7182,
    selectedHotspotId: 42,
    anchor: {
      anchorType: 'BETWEEN_ROWS',
      anchorIntent: 'AFTER_ATTRACTION',
      anchorIndex: 3,
      anchorFrom: 'Meenakshi Amman Temple',
      anchorTo: 'Pamban Bridge',
      anchorLabel: 'After Meenakshi Amman Temple',
      anchorTimeRange: '09:17 AM - 10:47 AM',
      afterRowType: 'attraction',
      beforeRowType: 'hotspot',
      afterHotspotId: 26,
      afterRouteHotspotId: 165801,
      beforeHotspotId: 40,
      beforeRouteHotspotId: 165803,
      isBeforeHotel: false,
    },
    allowP3Removal: false,
    allowP1P2Removal: false,
  };

  const payload = payloadFile ? readJsonFile(payloadFile) : defaultPayload;

  console.log(`[fit-preview] POST ${url}`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Response was not valid JSON. Status=${response.status}. Body=${text.slice(0, 1000)}`);
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(json, null, 2));
  }

  if (!response.ok) {
    printSection('HTTP Error', { status: response.status, body: json });
    process.exitCode = 1;
    return;
  }

  const { rows, target } = findRemovedRow(json, targetPattern);
  const attemptSequence = summarizeAttemptSequence(json);
  const timelineWindow = summarizeTimelineAroundAnchor(json, payload);
  const primaryBlocker = inferPrimaryBlocker(target, json);

  printSection('Preview Summary', {
    resultType: json?.resultType,
    canConfirm: json?.canConfirm,
    anchorLabel: json?.anchorLabel || json?.selectedAnchor?.anchorLabel,
    selectedStrategyLabel: json?.resolution?.selectedStrategyLabel || json?.selectedStrategyLabel || null,
    selectedStrategyKey: json?.resolution?.selectedStrategyKey || json?.selectedStrategyKey || null,
    manualTimingPolicy: json?.resolution?.manualTimingPolicy || json?.manualTimingPolicy || null,
    removedCount: rows.length,
  });

  printSection('All Removed Hotspots', rows.map((row) => ({
    name: row?.name,
    priority: row?.priority,
    priorityLabel: row?.priorityLabel,
    attemptedVisitSource: row?.attemptedVisitSource || null,
    originalVisitTime: row?.originalVisitTime || null,
    attemptedVisitTime: row?.attemptedVisitTime || null,
    operatingHours: row?.operatingHours || null,
    removalReasonCode: row?.removalReasonCode || null,
  })));

  printSection('Target Hotspot', target || `No removed hotspot matched pattern "${targetPattern}"`);
  printSection('Rule Interpretation', explainRule(target, json));
  printSection('Primary Blocker', primaryBlocker);

  if (target) {
    printSection('Why Ramanatha Was Removed', {
      reason: target?.reason || null,
      fitFailureExplanation: target?.fitFailureExplanation || null,
      routeEndOverflowMinutes: target?.routeEndOverflowMinutes || null,
      outsideOperatingMinutes: target?.outsideOperatingMinutes || null,
      attemptedVisitSource: target?.attemptedVisitSource || null,
      attemptedVisitTime: target?.attemptedVisitTime || null,
      selectedPosition: json?.selectedAnchor?.anchorLabel || json?.anchorLabel || null,
    });
  }

  printSection('Attempt Sequence', attemptSequence);
  printSection('Timeline Around Selected Anchor', timelineWindow);
  printSection('Raw Attempt Log', json?.attemptLog || []);
}

main().catch((error) => {
  console.error('\n[fit-preview-debug] failed');
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
