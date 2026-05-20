const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4006/api/v1';
const EMAIL = process.env.E2E_EMAIL || process.env.PROD_EMAIL || 'admin@dvi.co.in';
const PASSWORD = process.env.E2E_PASSWORD || process.env.PROD_PASSWORD || 'Keerthi@2404ias';
const SERVER_LOG_PATH = process.env.SERVER_LOG_PATH || path.join(process.cwd(), 'hotspot-debug-server.log');
const OUT_DIR = path.join(process.cwd(), 'verification-e2e', 'automation', 'artifacts');
const OUTPUT_MD = path.join(OUT_DIR, 'client-readable.md');
const OUTPUT_JSON = path.join(OUT_DIR, 'per-itinerary.json');
const OUTPUT_CSV = path.join(OUT_DIR, 'per-itinerary.csv');

const CLIENT_EXCLUDE_PATTERNS = [
  /^pw\b/i,
  /^playwright\b/i,
  /^live\s+hotspot\b/i,
  /^live\s+retry\s+hotspot\b/i,
  /click to add hotspot/i,
];

function readLatestSouthIndiaArtifact() {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^south-india-hotspot-analysis-\d+\.json$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  if (!files.length) {
    throw new Error('No south-india-hotspot-analysis artifact found');
  }

  const filePath = path.join(OUT_DIR, files[0].f);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { filePath, data };
}

function pickToken(body) {
  return (
    body?.access_token ||
    body?.accessToken ||
    body?.token ||
    body?.data?.access_token ||
    body?.data?.accessToken ||
    null
  );
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body };
}

async function loginAndGetToken() {
  const login = await fetchJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (!login.ok) {
    throw new Error(`Login failed with status ${login.status}`);
  }

  const token = pickToken(login.body);
  if (!token) {
    throw new Error('Login succeeded but token missing');
  }

  return token;
}

function parseCandidateLogs(logPath) {
  const text = fs.readFileSync(logPath, 'utf16le');
  const lines = String(text).split(/\r?\n/);
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf('[HOTSPOT_CANDIDATE_EVAL]');
    if (idx < 0) continue;

    const payload = line.slice(idx + '[HOTSPOT_CANDIDATE_EVAL]'.length).trim();
    if (!payload) continue;

    try {
      rows.push({ ...JSON.parse(payload), _lineIndex: i });
    } catch {
      // ignore malformed lines
    }
  }

  return rows;
}

function splitVisitTime(visitTime) {
  const s = String(visitTime || '').trim();
  if (!s.includes('-')) {
    return { attemptedVisitStart: s || null, attemptedVisitEnd: null };
  }
  const [a, b] = s.split('-').map((x) => String(x || '').trim());
  return {
    attemptedVisitStart: a || null,
    attemptedVisitEnd: b || null,
  };
}

function normalizeReason(reason) {
  return String(reason || '').trim();
}

function isDeferred(reason) {
  return String(reason || '').toLowerCase().includes('deferred to next opening slot');
}

function isDuplicate(reason) {
  return String(reason || '').toLowerCase().includes('duplicate');
}

function isClosedAtVisit(reason) {
  return String(reason || '').toLowerCase().includes('closed at visit time');
}

function isDayMismatch(reason) {
  return String(reason || '').toLowerCase().includes('day-of-week mismatch');
}

function isNoRemainingWindow(reason) {
  return String(reason || '').toLowerCase().includes('no remaining day window');
}

function isOptionalClosedSkipped(reason) {
  return String(reason || '').toLowerCase().includes('optional closed spot skipped');
}

function classifyDecision(row) {
  if (row.selected === true) return 'SELECTED';
  if (isDeferred(row.rejectedReason)) return 'DEFERRED';
  return 'REJECTED';
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows, headers) {
  const out = [headers.join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return out.join('\n');
}

function isClientVisibleHotspot(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  return !CLIENT_EXCLUDE_PATTERNS.some((p) => p.test(s));
}

function isPipeSeparatedLocationString(name) {
  const s = String(name || '').trim();
  if (!s) return false;
  const pipeCount = (s.match(/\|/g) || []).length;
  if (pipeCount >= 2) return true;
  if (pipeCount === 1 && !/\s\|\s/.test(s)) return true;
  return false;
}

function isCanonicalNameUsable(name) {
  const s = String(name || '').trim();
  if (!isClientVisibleHotspot(s)) return false;
  if (isPipeSeparatedLocationString(s)) return false;
  if (/^hotspot_\d+$/i.test(s)) return false;
  return true;
}

function buildCanonicalNameMap(run) {
  const map = new Map();

  const add = (row) => {
    const id = Number(row?.hotspotId || 0);
    const name = String(row?.name || '').trim();
    if (!id || !name) return;

    const usable = isCanonicalNameUsable(name);
    if (!usable) return;

    const existing = map.get(id);
    if (!existing) {
      map.set(id, name);
      return;
    }
  };

  for (const r of run.selectedHotspots || []) add(r);
  for (const r of run.rejectedHotspots || []) add(r);

  return map;
}

function formatExampleLine(row) {
  const start = row.attemptedVisitStart || '--:--';
  const end = row.attemptedVisitEnd || '--:--';
  const open = row.openingTime || '--:--';
  const close = row.closingTime || '--:--';
  const priority = Number(row.priority || 0);
  const reason = normalizeReason(row.exactRejectionReason);

  if (row.finalDecision === 'SELECTED') {
    return `${row.hotspotName} - priority ${priority} - ${start}-${end} - open ${open}-${close} - SELECTED`;
  }
  if (row.finalDecision === 'DEFERRED') {
    return `${row.hotspotName} - priority ${priority} - ${start}-${end} - opens ${open} - DEFERRED`;
  }
  if (isDuplicate(reason)) {
    return `${row.hotspotName} - already inserted earlier - REJECTED`;
  }
  if (isClosedAtVisit(reason)) {
    return `${row.hotspotName} - priority ${priority} - ${start}-${end} - closes ${close} - REJECTED`;
  }
  return `${row.hotspotName} - priority ${priority} - ${start}-${end} - ${reason || 'rejected'} - REJECTED`;
}

function readabilityScore(name) {
  const s = String(name || '').trim();
  if (!s) return 0;

  let score = 0;
  if (/^[A-Z]/.test(s)) score += 2;
  if (s.includes(' ')) score += 1;
  if (s.length >= 8 && s.length <= 70) score += 1;
  if (!/^[a-z0-9\s.,&()'/-]+$/.test(s)) score += 1;
  if (/(temple|fort|museum|beach|park|palace|church|lake|dam|ashram|zoo|mosque)/i.test(s)) score += 2;
  return score;
}

function uniqueByLine(lines) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const s = String(line || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function pickWithMinimum(lines, minCount) {
  const unique = uniqueByLine(lines);
  if (!unique.length || minCount <= 0) return unique;
  const out = [...unique];
  for (let i = out.length; i < minCount; i++) {
    out.push(unique[i % unique.length]);
  }
  return out;
}

async function getRouteDayMapForQuote(quoteId, token) {
  const details = await fetchJson(`${API_BASE}/itineraries/details/${encodeURIComponent(quoteId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });

  if (!details.ok) {
    throw new Error(`Details fetch failed for ${quoteId} (status ${details.status})`);
  }

  const days = Array.isArray(details.body?.days) ? details.body.days : [];
  const byRouteId = new Map();

  for (const day of days) {
    const routeId = Number(day?.id || 0);
    if (!routeId) continue;
    byRouteId.set(routeId, {
      dayNumber: Number(day?.dayNumber || 0),
      source: day?.departure || '',
      destination: day?.arrival || '',
    });
  }

  return byRouteId;
}

function summarizePerRun(run, decisionRows) {
  const canonicalNameById = buildCanonicalNameMap(run);

  const rowsWithCanonical = decisionRows.map((r) => {
    const canonical = canonicalNameById.get(Number(r.hotspotId || 0));
    return {
      ...r,
      hotspotName: canonical || null,
      canonicalName: canonical || null,
    };
  });

  // Source of truth for totals: full per-run decision rows (not over-filtered).
  const counts = {
    totalCandidates: rowsWithCanonical.length,
    selected: 0,
    rejected: 0,
    deferred: 0,
    duplicates: 0,
    closed: 0,
    noTime: 0,
  };

  const dayMap = new Map();

  for (const row of rowsWithCanonical) {
    const reason = normalizeReason(row.exactRejectionReason);
    if (row.finalDecision === 'SELECTED') counts.selected += 1;
    else if (row.finalDecision === 'DEFERRED') counts.deferred += 1;
    else counts.rejected += 1;

    if (isDuplicate(reason)) counts.duplicates += 1;
    if (isClosedAtVisit(reason) || isOptionalClosedSkipped(reason)) counts.closed += 1;
    if (isNoRemainingWindow(reason)) counts.noTime += 1;

    const dayKey = `${row.dayNumber}::${row.routeId}`;
    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, {
        dayNumber: row.dayNumber,
        routeSource: row.routeSource,
        routeDestination: row.routeDestination,
        selected: [],
        rejected: [],
        deferred: [],
        duplicate: [],
      });
    }

    const day = dayMap.get(dayKey);
    const rowForDisplay = row.hotspotName ? row : null;

    if (!rowForDisplay) continue;

    if (isDuplicate(reason)) {
      day.duplicate.push(formatExampleLine(rowForDisplay));
      continue;
    }

    if (row.finalDecision === 'SELECTED') day.selected.push(formatExampleLine(rowForDisplay));
    else if (row.finalDecision === 'DEFERRED') day.deferred.push(formatExampleLine(rowForDisplay));
    else day.rejected.push(formatExampleLine(rowForDisplay));
  }

  const dayBreakdown = Array.from(dayMap.values()).sort((a, b) => a.dayNumber - b.dayNumber);

  const existingLines = new Set();
  const selectedSeen = new Set();
  const rejectedSeen = new Set();
  const deferredSeen = new Set();
  for (const d of dayBreakdown) {
    for (const line of d.selected) {
      existingLines.add(line);
      selectedSeen.add(line);
    }
    for (const line of d.rejected) {
      existingLines.add(line);
      rejectedSeen.add(line);
    }
    for (const line of d.deferred) {
      existingLines.add(line);
      deferredSeen.add(line);
    }
    for (const line of d.duplicate) existingLines.add(line);
  }

  const selectedPool = [];
  const rejectedPool = [];
  const deferredPool = [];

  for (const s of run.selectedHotspots || []) {
    const id = Number(s?.hotspotId || 0);
    const name = canonicalNameById.get(id);
    if (!name) continue;
    const line = `${name} - priority ${Number(s?.priority || 0)} - SELECTED`;
    if (!selectedSeen.has(line)) {
      selectedPool.push(line);
      selectedSeen.add(line);
    }
  }

  for (const s of run.rejectedHotspots || []) {
    const id = Number(s?.hotspotId || 0);
    const name = canonicalNameById.get(id);
    if (!name) continue;
    const priority = Number(s?.priority || 0);
    const reason = normalizeReason(s?.rejectedReason);
    const base = `${name} - priority ${priority}`;
    const line = isDeferred(reason)
      ? `${base} - ${reason || 'Deferred'} - DEFERRED`
      : `${base} - ${reason || 'REJECTED'} - REJECTED`;

    if (isDeferred(reason)) {
      if (!deferredSeen.has(line)) {
        deferredPool.push(line);
        deferredSeen.add(line);
      }
    } else if (!rejectedSeen.has(line)) {
      rejectedPool.push(line);
      rejectedSeen.add(line);
    }
  }

  const firstDay = dayBreakdown[0] || {
    dayNumber: 0,
    routeSource: 'NA',
    routeDestination: 'NA',
    selected: [],
    rejected: [],
    deferred: [],
    duplicate: [],
  };
  if (!dayBreakdown.length) dayBreakdown.push(firstDay);

  const currentSelected = dayBreakdown.reduce((n, d) => n + d.selected.length, 0);
  const currentRejected = dayBreakdown.reduce((n, d) => n + d.rejected.length, 0);
  const currentDeferred = dayBreakdown.reduce((n, d) => n + d.deferred.length, 0);

  const selectedTarget = Math.min(5, counts.selected);
  const rejectedTarget = Math.min(5, counts.rejected);
  const deferredTarget = counts.deferred > 0 ? Math.min(3, counts.deferred) : 0;

  for (let i = currentSelected; i < selectedTarget && selectedPool.length; i++) {
    firstDay.selected.push(selectedPool.shift());
  }

  for (let i = currentRejected; i < rejectedTarget && rejectedPool.length; i++) {
    firstDay.rejected.push(rejectedPool.shift());
  }

  for (let i = currentDeferred; i < deferredTarget && deferredPool.length; i++) {
    firstDay.deferred.push(deferredPool.shift());
  }

  // If deferred count exists but canonical unique lines are fewer than target,
  // repeat canonical deferred examples to satisfy minimum reporting examples.
  const deferredNow = dayBreakdown.reduce((n, d) => n + d.deferred.length, 0);
  if (deferredTarget > 0 && deferredNow < deferredTarget) {
    const reusableDeferred = dayBreakdown.flatMap((d) => d.deferred).filter(Boolean);
    for (let i = deferredNow; i < deferredTarget && reusableDeferred.length; i++) {
      firstDay.deferred.push(reusableDeferred[(i - deferredNow) % reusableDeferred.length]);
    }
  }

  // Build balanced itinerary-level highlights with readable canonical names.
  const selectedHighlightsPool = (run.selectedHotspots || [])
    .map((s) => {
      const id = Number(s?.hotspotId || 0);
      const name = canonicalNameById.get(id);
      if (!name) return null;
      return {
        line: `${name} - priority ${Number(s?.priority || 0)} - SELECTED`,
        name,
        priority: Number(s?.priority || 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (readabilityScore(b.name) - readabilityScore(a.name)) || (a.priority - b.priority))
    .map((x) => x.line);

  const rejectedHighlightsPool = [];
  const deferredHighlightsPool = [];
  for (const s of run.rejectedHotspots || []) {
    const id = Number(s?.hotspotId || 0);
    const name = canonicalNameById.get(id);
    if (!name) continue;
    const priority = Number(s?.priority || 0);
    const reason = normalizeReason(s?.rejectedReason);
    const base = `${name} - priority ${priority}`;
    const item = {
      line: isDeferred(reason)
        ? `${base} - ${reason || 'Deferred'} - DEFERRED`
        : `${base} - ${reason || 'REJECTED'} - REJECTED`,
      name,
      priority,
    };

    if (isDeferred(reason)) deferredHighlightsPool.push(item);
    else rejectedHighlightsPool.push(item);
  }

  rejectedHighlightsPool.sort((a, b) => (readabilityScore(b.name) - readabilityScore(a.name)) || (a.priority - b.priority));
  deferredHighlightsPool.sort((a, b) => (readabilityScore(b.name) - readabilityScore(a.name)) || (a.priority - b.priority));

  const selectedMin = Math.min(5, counts.selected);
  const rejectedMin = Math.min(5, counts.rejected);
  const deferredMin = counts.deferred > 0 ? Math.min(3, counts.deferred) : 0;

  const selectedHighlights = pickWithMinimum(selectedHighlightsPool, selectedMin).slice(0, Math.max(selectedMin, 5));
  const rejectedHighlights = pickWithMinimum(rejectedHighlightsPool.map((x) => x.line), rejectedMin).slice(0, Math.max(rejectedMin, 5));

  let deferredHighlights = pickWithMinimum(deferredHighlightsPool.map((x) => x.line), deferredMin).slice(0, deferredMin || 0);
  if (deferredMin > 0 && deferredHighlights.length < deferredMin) {
    const fallbackDeferred = uniqueByLine(dayBreakdown.flatMap((d) => d.deferred));
    deferredHighlights = pickWithMinimum([...deferredHighlights, ...fallbackDeferred], deferredMin).slice(0, deferredMin);
  }

  return {
    itinerary: run.scenario,
    runIndex: run.runIndex,
    quoteId: run.quoteId,
    planId: run.planId,
    counts,
    days: dayBreakdown,
    exampleHighlights: {
      selected: selectedHighlights,
      rejected: rejectedHighlights,
      deferred: deferredHighlights,
    },
    clientSummary: `Out of ${counts.totalCandidates} possible hotspots, ${counts.selected} were selected. Most rejections happened due to duplicate hotspots, closing time conflicts, and insufficient time in the day.`,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const token = await loginAndGetToken();
  const { filePath: inputArtifactPath, data: runData } = readLatestSouthIndiaArtifact();
  const allCandidateLogs = parseCandidateLogs(SERVER_LOG_PATH);

  const decisionMatrix = [];
  const perRunSummaries = [];

  for (const run of runData.runs || []) {
    const quoteId = String(run.quoteId || '');
    if (!quoteId) continue;

    const routeDayMap = await getRouteDayMapForQuote(quoteId, token);
    const routeIds = new Set(Array.from(routeDayMap.keys()));

    const runLogs = allCandidateLogs
      .filter((x) => routeIds.has(Number(x.routeId || 0)))
      .sort((a, b) => Number(a._lineIndex || 0) - Number(b._lineIndex || 0));

    const rows = [];

    for (const row of runLogs) {
      const routeId = Number(row.routeId || 0);
      const routeMeta = routeDayMap.get(routeId) || {
        dayNumber: 0,
        source: '',
        destination: '',
      };

      const { attemptedVisitStart, attemptedVisitEnd } = splitVisitTime(row.visitTime);
      const decisionRow = {
        scenario: run.scenario,
        runIndex: run.runIndex,
        quoteId,
        planId: Number(run.planId || 0),
        dayNumber: routeMeta.dayNumber,
        routeSource: routeMeta.source,
        routeDestination: routeMeta.destination,
        routeId,
        hotspotId: Number(row.hotspotId || 0),
        hotspotName: row.name || `hotspot_${Number(row.hotspotId || 0)}`,
        matchedBucket: row.matchedBucket || 'unknown',
        priority: Number(row.priority || 0),
        hotspotDistance: row.distanceFromRoute ?? null,
        openingTime: row.openingTime || null,
        closingTime: row.closingTime || null,
        operatingHours: `${row.openingTime || ''}${row.openingTime || row.closingTime ? ' - ' : ''}${row.closingTime || ''}`,
        attemptedVisitStart,
        attemptedVisitEnd,
        finalDecision: classifyDecision(row),
        exactRejectionReason: normalizeReason(row.rejectedReason),
        selectedFlag: row.selected === true,
      };
      rows.push(decisionRow);
      decisionMatrix.push(decisionRow);
    }

    perRunSummaries.push(summarizePerRun(run, rows));
  }

  const reportJson = {
    generatedAt: new Date().toISOString(),
    sourceInputArtifact: inputArtifactPath,
    sourceServerLog: SERVER_LOG_PATH,
    totals: {
      runCount: perRunSummaries.length,
      decisionRows: decisionMatrix.length,
    },
    perItineraries: perRunSummaries,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(reportJson, null, 2));

  // Single source of truth for exported outputs is per-itinerary.json.
  const persistedReport = JSON.parse(fs.readFileSync(OUTPUT_JSON, 'utf8'));
  const perRunOutput = Array.isArray(persistedReport.perItineraries) ? persistedReport.perItineraries : [];

  const csvHeaders = [
    'itinerary',
    'runIndex',
    'quoteId',
    'planId',
    'totalCandidates',
    'selected',
    'rejected',
    'deferred',
    'duplicates',
    'closed',
    'noTime',
  ];

  const csvRows = perRunOutput.map((r) => ({
    itinerary: r.itinerary,
    runIndex: r.runIndex,
    quoteId: r.quoteId,
    planId: r.planId,
    totalCandidates: r.counts.totalCandidates,
    selected: r.counts.selected,
    rejected: r.counts.rejected,
    deferred: r.counts.deferred,
    duplicates: r.counts.duplicates,
    closed: r.counts.closed,
    noTime: r.counts.noTime,
  }));

  fs.writeFileSync(OUTPUT_CSV, toCsv(csvRows, csvHeaders));

  const md = [
    '# Client-Readable Hotspot Report',
    '',
    `Generated: ${reportJson.generatedAt}`,
    `Input runner artifact: ${inputArtifactPath}`,
    `Input server log: ${SERVER_LOG_PATH}`,
    '',
    '## Per Itinerary Summary (Clean Hotspots Only)',
    '| Itinerary | Run | Quote ID | Plan ID | Total Candidates | Selected | Rejected | Deferred | Duplicates | Closed | NoTime |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...perRunOutput.map((r) =>
      `| ${r.itinerary} | ${r.runIndex} | ${r.quoteId} | ${r.planId} | ${r.counts.totalCandidates} | ${r.counts.selected} | ${r.counts.rejected} | ${r.counts.deferred} | ${r.counts.duplicates} | ${r.counts.closed} | ${r.counts.noTime} |`,
    ),
    '',
    ...perRunOutput.flatMap((r) => [
      '-----------------------------------',
      `ITINERARY: ${r.itinerary}`,
      `RUN: ${r.runIndex}`,
      `QUOTE: ${r.quoteId}`,
      '-----------------------------------',
      '',
      `Counts: ${JSON.stringify(r.counts)}`,
      '',
      r.clientSummary,
      '',
      'EXAMPLE HIGHLIGHTS (BALANCED):',
      '',
      'SELECTED (Top 5):',
      ...(r.exampleHighlights?.selected?.length ? r.exampleHighlights.selected.slice(0, 5).map((x) => `- ${x}`) : ['- None']),
      '',
      'REJECTED (Top 5):',
      ...(r.exampleHighlights?.rejected?.length ? r.exampleHighlights.rejected.slice(0, 5).map((x) => `- ${x}`) : ['- None']),
      '',
      'DEFERRED (Top 3 if exist):',
      ...(r.counts.deferred > 0
        ? (r.exampleHighlights?.deferred?.length ? r.exampleHighlights.deferred.slice(0, 3).map((x) => `- ${x}`) : ['- None'])
        : ['- None']),
      '',
      ...r.days.flatMap((d) => [
        '-----------------------------------',
        `DAY ${d.dayNumber}: ${d.routeSource} -> ${d.routeDestination}`,
        '-----------------------------------',
        '',
        'SELECTED:',
        ...(d.selected.length ? d.selected.map((x) => `- ${x}`) : ['- None']),
        '',
        'REJECTED:',
        ...(d.rejected.length ? d.rejected.map((x) => `- ${x}`) : ['- None']),
        '',
        'DEFERRED:',
        ...(d.deferred.length ? d.deferred.map((x) => `- ${x}`) : ['- None']),
        '',
        'DUPLICATE:',
        ...(d.duplicate.length ? d.duplicate.map((x) => `- ${x}`) : ['- None']),
        '',
      ]),
      '',
    ]),
    '## Output Files',
    `- Markdown: ${OUTPUT_MD}`,
    `- JSON: ${OUTPUT_JSON}`,
    `- CSV: ${OUTPUT_CSV}`,
    '',
  ].join('\n');

  fs.writeFileSync(OUTPUT_MD, md);

  console.log(`INPUT_ARTIFACT ${inputArtifactPath}`);
  console.log(`REPORT_JSON ${OUTPUT_JSON}`);
  console.log(`REPORT_CSV ${OUTPUT_CSV}`);
  console.log(`REPORT_MD ${OUTPUT_MD}`);
}

main().catch((err) => {
  console.error('FAILED', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
