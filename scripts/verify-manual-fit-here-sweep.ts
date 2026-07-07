import 'dotenv/config';
import { createConnection } from 'mysql2/promise';

type RouteRow = {
  itinerary_route_ID: number;
  itinerary_plan_ID: number;
  no_of_days: number;
  itinerary_route_date: Date | string | null;
  location_name: string | null;
  route_start_time: string | null;
  route_end_time: string | null;
};

type AttractionRow = {
  route_hotspot_ID: number;
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_start_time: string | null;
  hotspot_end_time: string | null;
};

type CandidateRow = {
  id: number;
  name: string;
  actionDisabled?: boolean;
  alreadyAdded?: boolean;
  availabilityStatus?: string | null;
};

type SweepConfig = {
  baseUrl: string;
  confirm: boolean;
  includeExplicitCases: boolean;
  jsonOnly: boolean;
  maxPlans: number;
  planIds: number[];
  recentPlanCount: number;
};

type ManualFitPayload = {
  routeId: number;
  selectedHotspotId: number;
  anchor: Record<string, any>;
  allowP3Removal: boolean;
  allowP1P2Removal: boolean;
};

type SweepResult = {
  label: string;
  planId: number;
  routeId: number;
  selectedHotspotId: number;
  candidateName?: string | null;
  routeDay?: number | null;
  routeDate?: string | null;
  previewStatus: number;
  previewOk: boolean;
  resultType: string | null;
  canConfirm: boolean | null;
  previewCode: string | null;
  previewMessage: string | null;
  finalizedTimelineCount: number;
  removedIds: number[];
  confirmStatus: number | null;
  confirmOk: boolean | null;
  confirmCode: string | null;
  confirmMessage: string | null;
  inserted: boolean | null;
  attemptId: string | null;
  skipped?: boolean;
  skipReason?: string | null;
};

const DEFAULT_BASE_URL = String(process.env.FIT_BASE_URL || 'http://127.0.0.1:4006/api/v1').replace(/\/$/, '');
const DEFAULT_MAX_PLANS = 2;
const DEFAULT_RECENT_PLAN_COUNT = 2;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return fallback;
}

function parseIntValue(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseArgs(): SweepConfig {
  const args = process.argv.slice(2);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || '');
    if (!token.startsWith('--')) continue;
    if (token.includes('=')) {
      const [rawKey, ...rest] = token.slice(2).split('=');
      parsed.set(rawKey, rest.join('=').trim());
      continue;
    }
    const key = token.slice(2);
    const next = String(args[index + 1] || '');
    if (next && !next.startsWith('--')) {
      parsed.set(key, next.trim());
      index += 1;
      continue;
    }
    parsed.set(key, 'true');
  }

  const explicitPlanIds = String(parsed.get('planIds') || parsed.get('plans') || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);

  return {
    baseUrl: String(parsed.get('baseUrl') || DEFAULT_BASE_URL).replace(/\/$/, ''),
    confirm: parseBool(parsed.get('confirm'), false),
    includeExplicitCases: parseBool(parsed.get('includeExplicitCases'), true),
    jsonOnly: parseBool(parsed.get('json'), false),
    maxPlans: parseIntValue(parsed.get('maxPlans'), DEFAULT_MAX_PLANS),
    planIds: explicitPlanIds,
    recentPlanCount: parseIntValue(parsed.get('recentPlanCount'), DEFAULT_RECENT_PLAN_COUNT),
  };
}

async function login(baseUrl: string): Promise<string> {
  const existing = String(process.env.DVI_TEST_TOKEN || process.env.FIT_TOKEN || '').trim();
  if (existing) return existing;

  const email = String(process.env.LOGIN_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.LOGIN_PASSWORD || 'Keerthi@2404ias').trim();
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text for the thrown error
  }

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const token = body?.accessToken || body?.token || body?.data?.accessToken || body?.data?.token;
  if (!token) {
    throw new Error('Login succeeded but no access token was returned.');
  }
  return String(token);
}

async function postJson(baseUrl: string, token: string, path: string, payload: any) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw body
  }
  return { response, body };
}

async function getJson(baseUrl: string, token: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw body
  }
  return { response, body };
}

function extractRemovedIds(body: any): number[] {
  const ids = new Set<number>();
  for (const row of Array.isArray(body?.removedHotspots) ? body.removedHotspots : []) {
    const id = Number(row?.hotspotId || row?.id || 0);
    if (id > 0) ids.add(id);
  }
  for (const row of Array.isArray(body?.changesRequiredDisplay?.removedItems)
    ? body.changesRequiredDisplay.removedItems
    : []) {
    const id = Number(row?.hotspotId || row?.id || 0);
    if (id > 0) ids.add(id);
  }
  return Array.from(ids);
}

function formatRouteDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function buildBeforeFirstPayload(routeId: number, selectedHotspotId: number, firstAttraction: AttractionRow): ManualFitPayload {
  const firstName = String(firstAttraction.hotspot_name || `Hotspot #${firstAttraction.hotspot_ID}`).trim();
  return {
    routeId,
    selectedHotspotId,
    anchor: {
      anchorType: 'BETWEEN_ROWS',
      anchorIntent: 'AFTER_START',
      anchorIndex: 0,
      anchorFrom: 'Start your Journey',
      anchorTo: firstName,
      anchorLabel: `Before first attraction: ${firstName}`,
      anchorTimeRange: '08:00 AM - 09:00 AM',
      afterRowType: 'start',
      beforeRowType: 'hotspot',
      afterHotspotId: null,
      afterRouteHotspotId: null,
      beforeHotspotId: Number(firstAttraction.hotspot_ID),
      beforeRouteHotspotId: Number(firstAttraction.route_hotspot_ID),
    },
    allowP3Removal: true,
    allowP1P2Removal: true,
  };
}

function buildExplicitCases(): Array<{ label: string; planId: number; payload: ManualFitPayload }> {
  return [
    {
      label: '9825-8153-munnar-before-first',
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
      label: '9825-8153-munnar-after-oottupura',
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
      label: '9825-8153-munnar-after-clay-oven',
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
      label: '9825-8154-munnar-after-echo-point',
      planId: 9825,
      payload: {
        routeId: 8154,
        selectedHotspotId: 898,
        anchor: {
          anchorType: 'BETWEEN_ROWS',
          anchorIntent: 'AFTER_ATTRACTION',
          anchorIndex: 3,
          anchorFrom: 'Echo Point',
          anchorTo: 'Mattupetty Dam and Lake',
          anchorLabel: 'After Echo Point',
          anchorTimeRange: '09:46 AM - 10:31 AM',
          afterRowType: 'attraction',
          beforeRowType: 'hotspot',
          afterHotspotId: 483,
          afterRouteHotspotId: 128357,
          beforeHotspotId: 223,
          beforeRouteHotspotId: 128363,
        },
        allowP3Removal: true,
        allowP1P2Removal: true,
      },
    },
    {
      label: '9825-8154-munnar-after-mattupetty',
      planId: 9825,
      payload: {
        routeId: 8154,
        selectedHotspotId: 898,
        anchor: {
          anchorType: 'BETWEEN_ROWS',
          anchorIntent: 'AFTER_ATTRACTION',
          anchorIndex: 6,
          anchorFrom: 'Mattupetty Dam and Lake',
          anchorTo: 'Munnar Rose Garden',
          anchorLabel: 'After Mattupetty Dam and Lake',
          anchorTimeRange: '11:01 AM - 12:01 PM',
          afterRowType: 'attraction',
          beforeRowType: 'hotspot',
          afterHotspotId: 223,
          afterRouteHotspotId: 128363,
          beforeHotspotId: 227,
          beforeRouteHotspotId: 128365,
        },
        allowP3Removal: true,
        allowP1P2Removal: true,
      },
    },
    {
      label: '9824-8139-cubbon-after-mysore-zoo',
      planId: 9824,
      payload: {
        routeId: 8139,
        selectedHotspotId: 110,
        anchor: {
          anchorType: 'BETWEEN_ROWS',
          anchorIntent: 'AFTER_ATTRACTION',
          anchorIndex: 1,
          anchorFrom: 'Mysore Zoo',
          anchorTo: "St. Philomena's Cathedral Church",
          anchorLabel: 'After Mysore Zoo',
          anchorTimeRange: '05:09 PM - 08:09 PM',
          afterRowType: 'attraction',
          beforeRowType: 'hotspot',
          afterHotspotId: 124,
          afterRouteHotspotId: 117355,
          beforeHotspotId: 125,
          beforeRouteHotspotId: 117364,
        },
        allowP3Removal: true,
        allowP1P2Removal: true,
      },
    },
  ];
}

async function fetchRecentPlanIds(db: any, maxPlans: number): Promise<number[]> {
  const [rows] = await db.query(
    `
      SELECT itinerary_plan_ID, MAX(createdon) AS last_created_on
      FROM dvi_itinerary_route_details
      WHERE deleted = 0
      GROUP BY itinerary_plan_ID
      ORDER BY itinerary_plan_ID DESC
      LIMIT ?
    `,
    [maxPlans],
  );
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => Number(row?.itinerary_plan_ID || 0))
    .filter((value: number) => value > 0);
}

async function fetchPlanRoutes(db: any, planId: number): Promise<RouteRow[]> {
  const [rows] = await db.query(
    `
      SELECT itinerary_plan_ID, itinerary_route_ID, no_of_days, itinerary_route_date, location_name, route_start_time, route_end_time
      FROM dvi_itinerary_route_details
      WHERE itinerary_plan_ID = ? AND deleted = 0
      ORDER BY no_of_days ASC, itinerary_route_ID ASC
    `,
    [planId],
  );
  return Array.isArray(rows) ? (rows as RouteRow[]) : [];
}

async function fetchRouteAttractions(db: any, routeId: number): Promise<AttractionRow[]> {
  const [rows] = await db.query(
    `
      SELECT rh.route_hotspot_ID, rh.hotspot_ID, hp.hotspot_name, rh.hotspot_start_time, rh.hotspot_end_time
      FROM dvi_itinerary_route_hotspot_details rh
      LEFT JOIN dvi_hotspot_place hp ON hp.hotspot_ID = rh.hotspot_ID
      WHERE rh.itinerary_route_ID = ? AND rh.deleted = 0 AND rh.item_type = 4
      ORDER BY rh.hotspot_start_time ASC, rh.route_hotspot_ID ASC
    `,
    [routeId],
  );
  return Array.isArray(rows) ? (rows as AttractionRow[]) : [];
}

async function fetchCandidate(baseUrl: string, token: string, routeId: number): Promise<CandidateRow | null> {
  const response = await getJson(baseUrl, token, `/itineraries/hotspots/available/${routeId}`);
  if (!response.response.ok || !Array.isArray(response.body)) return null;
  const availableRows = response.body as CandidateRow[];
  return availableRows.find((row) =>
    row?.actionDisabled !== true
      && row?.alreadyAdded !== true
      && String(row?.availabilityStatus || '').trim().toUpperCase() === 'AVAILABLE',
  ) || availableRows.find((row) =>
    row?.actionDisabled !== true
      && row?.alreadyAdded !== true,
  ) || null;
}

async function runCase(
  baseUrl: string,
  token: string,
  planId: number,
  label: string,
  payload: ManualFitPayload,
  confirm: boolean,
): Promise<SweepResult> {
  const previewPath = `/itineraries/${planId}/manual-hotspot/fit-preview`;
  const preview = await postJson(baseUrl, token, previewPath, payload);
  const removedIds = extractRemovedIds(preview.body);

  const result: SweepResult = {
    label,
    planId,
    routeId: Number(payload.routeId),
    selectedHotspotId: Number(payload.selectedHotspotId),
    previewStatus: preview.response.status,
    previewOk: preview.response.ok,
    resultType: String(preview.body?.resultType || '') || null,
    canConfirm: typeof preview.body?.canConfirm === 'boolean' ? preview.body.canConfirm : null,
    previewCode: String(preview.body?.code || '') || null,
    previewMessage: String(preview.body?.message || '') || null,
    finalizedTimelineCount: Array.isArray(preview.body?.finalizedTimeline) ? preview.body.finalizedTimeline.length : 0,
    removedIds,
    confirmStatus: null,
    confirmOk: null,
    confirmCode: null,
    confirmMessage: null,
    inserted: null,
    attemptId: String(preview.body?.attemptId || '') || null,
  };

  if (!confirm || result.previewOk !== true || result.canConfirm !== true || !result.attemptId) {
    return result;
  }

  const confirmResponse = await postJson(baseUrl, token, `/itineraries/${planId}/manual-hotspot/fit-confirm`, {
    attemptId: result.attemptId,
    allowTimingRisk: false,
    allowClosedHotspotConflict: false,
    allowPriorityRemoval: true,
    acknowledgedRemovedHotspotIds: removedIds,
  });

  result.confirmStatus = confirmResponse.response.status;
  result.confirmOk = confirmResponse.response.ok;
  result.confirmCode = String(confirmResponse.body?.code || '') || null;
  result.confirmMessage = String(confirmResponse.body?.message || '') || null;
  result.inserted = confirmResponse.body?.inserted === true || confirmResponse.body?.success === true;
  return result;
}

function printHumanSummary(summary: any, results: SweepResult[]) {
  console.log(`Manual Fit sweep summary`);
  console.log(`- total cases: ${summary.total}`);
  console.log(`- preview OK: ${summary.previewOk}`);
  console.log(`- preview canConfirm=true: ${summary.canConfirm}`);
  console.log(`- confirm OK: ${summary.confirmOk}`);
  console.log(`- confirm 409 count: ${summary.confirm409}`);
  console.log(`- preview 409 stale count: ${summary.previewAnchorStale}`);
  console.log(`- selected-closed preview count: ${summary.previewSelectedClosed}`);
  console.log(`- preview failures: ${summary.previewFailures}`);
  console.log(``);

  for (const row of results) {
    const confirmText = row.confirmStatus == null
      ? 'confirm: not-run'
      : `confirm: ${row.confirmStatus}${row.confirmCode ? ` ${row.confirmCode}` : ''}`;
    console.log(
      `- ${row.label} | preview: ${row.previewStatus}${row.resultType ? ` ${row.resultType}` : ''}${row.previewCode ? ` ${row.previewCode}` : ''} | ${confirmText}`,
    );
  }
}

async function main() {
  const config = parseArgs();
  const token = await login(config.baseUrl);
  const db = await createConnection(String(process.env.DATABASE_URL || 'mysql://dvi_user:myDvi123!@localhost:3306/dvi_main'));
  const results: SweepResult[] = [];

  try {
    if (config.includeExplicitCases) {
      for (const testCase of buildExplicitCases()) {
        results.push(await runCase(
          config.baseUrl,
          token,
          testCase.planId,
          testCase.label,
          testCase.payload,
          config.confirm,
        ));
      }
    }

    const planIds = config.planIds.length > 0
      ? config.planIds
      : await fetchRecentPlanIds(db, config.recentPlanCount || config.maxPlans);

    for (const planId of planIds.slice(0, config.maxPlans)) {
      const routes = await fetchPlanRoutes(db, planId);
      for (const route of routes) {
        const routeId = Number(route.itinerary_route_ID || 0);
        const routeDay = Number(route.no_of_days || 0) || null;
        const routeDate = formatRouteDate(route.itinerary_route_date);
        const attractions = await fetchRouteAttractions(db, routeId);
        if (attractions.length === 0) {
          results.push({
            label: `plan-${planId}-day-${routeDay || '?'}-no-attractions`,
            planId,
            routeId,
            selectedHotspotId: 0,
            previewStatus: 0,
            previewOk: false,
            resultType: null,
            canConfirm: null,
            previewCode: null,
            previewMessage: null,
            finalizedTimelineCount: 0,
            removedIds: [],
            confirmStatus: null,
            confirmOk: null,
            confirmCode: null,
            confirmMessage: null,
            inserted: null,
            attemptId: null,
            routeDay,
            routeDate,
            skipped: true,
            skipReason: 'No attraction rows exist on this route.',
          });
          continue;
        }

        const candidate = await fetchCandidate(config.baseUrl, token, routeId);
        if (!candidate) {
          results.push({
            label: `plan-${planId}-day-${routeDay || '?'}-no-candidate`,
            planId,
            routeId,
            selectedHotspotId: 0,
            previewStatus: 0,
            previewOk: false,
            resultType: null,
            canConfirm: null,
            previewCode: null,
            previewMessage: null,
            finalizedTimelineCount: 0,
            removedIds: [],
            confirmStatus: null,
            confirmOk: null,
            confirmCode: null,
            confirmMessage: null,
            inserted: null,
            attemptId: null,
            routeDay,
            routeDate,
            skipped: true,
            skipReason: 'No available manual hotspot candidate was returned for this route.',
          });
          continue;
        }

        const payload = buildBeforeFirstPayload(routeId, Number(candidate.id), attractions[0]);
        const label = `plan-${planId}-day-${routeDay || '?'}-before-first-${candidate.name}`;
        const result = await runCase(config.baseUrl, token, planId, label, payload, config.confirm);
        result.routeDay = routeDay;
        result.routeDate = routeDate;
        result.candidateName = String(candidate.name || '') || null;
        results.push(result);
      }
    }
  } finally {
    await db.end();
  }

  const summary = {
    total: results.length,
    previewOk: results.filter((row) => row.previewOk === true).length,
    canConfirm: results.filter((row) => row.canConfirm === true).length,
    confirmOk: results.filter((row) => row.confirmOk === true).length,
    confirm409: results.filter((row) => Number(row.confirmStatus || 0) === 409).length,
    previewFailures: results.filter((row) => row.previewOk === false && row.skipped !== true).length,
    previewAnchorStale: results.filter((row) => String(row.previewCode || '') === 'MANUAL_FIT_HERE_ANCHOR_STALE').length,
    previewSelectedClosed: results.filter((row) => String(row.resultType || '') === 'SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME').length,
    skipped: results.filter((row) => row.skipped === true).length,
  };

  if (!config.jsonOnly) {
    printHumanSummary(summary, results);
    console.log('');
  }

  console.log(JSON.stringify({ config, summary, results }, null, 2));

  if (summary.confirm409 > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
