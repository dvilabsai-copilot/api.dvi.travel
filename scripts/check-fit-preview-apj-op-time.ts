import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PLAN_ID = 9774;
const DEFAULT_ROUTE_ID = 7761;
const DEFAULT_SELECTED_HOTSPOT_ID = 41;
const DEFAULT_ATTEMPT_ID = "6555a945-fca7-4f4a-b8c6-4f1a559ddaf6";
const DEFAULT_PREVIEW_PAYLOAD = {
  routeId: DEFAULT_ROUTE_ID,
  selectedHotspotId: DEFAULT_SELECTED_HOTSPOT_ID,
  anchor: {
    anchorType: "BETWEEN_ROWS",
    anchorIntent: "AFTER_ATTRACTION",
    anchorIndex: 2,
    anchorFrom: "Ramanatha swami Temple",
    anchorTo: "Agni Teertham",
    anchorLabel: "After Ramanatha swami Temple",
    afterRouteHotspotId: 115427,
    afterHotspotId: 35,
    beforeRouteHotspotId: 115429,
    beforeHotspotId: 36,
    afterRowType: "attraction",
    beforeRowType: "attraction",
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};
const DEFAULT_CONFIRM_PAYLOAD = {
  attemptId: DEFAULT_ATTEMPT_ID,
  allowTimingRisk: true,
  allowPriorityRemoval: true,
  allowClosedHotspotConflict: false,
  acknowledgedRemovedHotspotIds: [27],
};

const FIT_MODE = String(process.env.FIT_MODE || "confirm").trim().toLowerCase();
const SKIP_PREVIEW = String(process.env.FIT_SKIP_PREVIEW || "").trim().toLowerCase() === "true";
const PREVIEW_URL =
  process.env.FIT_PREVIEW_URL ||
  `http://127.0.0.1:4006/api/v1/itineraries/${DEFAULT_PLAN_ID}/manual-hotspot/fit-preview`;
const CONFIRM_URL =
  process.env.FIT_CONFIRM_URL ||
  `http://127.0.0.1:4006/api/v1/itineraries/${DEFAULT_PLAN_ID}/manual-hotspot/fit-confirm`;
const LOGIN_URL =
  process.env.FIT_LOGIN_URL ||
  "http://127.0.0.1:4006/api/v1/auth/login";

const USER_EMAIL = process.env.FIT_USER_EMAIL || "admin@dvi.co.in";
const USER_PASSWORD = process.env.FIT_USER_PASSWORD || "Keerthi@2404ias";

function parseJsonPayload(text: string, sourceLabel: string): any {
  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch (error: any) {
    throw new Error(`${sourceLabel} is not valid JSON: ${error?.message || error}`);
  }
}

function loadJsonPayload(
  fallback: any,
  fileEnvNames: string[],
  textEnvNames: string[],
): any {
  for (const envName of fileEnvNames) {
    const payloadFile = String(process.env[envName] || "").trim();
    if (!payloadFile) continue;

    const filePath = path.resolve(payloadFile);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  for (const envName of textEnvNames) {
    const rawText = String(process.env[envName] || "").trim();
    if (!rawText) continue;

    return parseJsonPayload(rawText, envName);
  }

  return fallback;
}

const previewPayload = loadJsonPayload(
  DEFAULT_PREVIEW_PAYLOAD,
  ["FIT_PREVIEW_PAYLOAD_FILE"],
  ["FIT_PREVIEW_PAYLOAD", "FIT_PREVIEW_BODY"],
);
const confirmPayloadTemplate = loadJsonPayload(
  DEFAULT_CONFIRM_PAYLOAD,
  ["FIT_CONFIRM_PAYLOAD_FILE"],
  ["FIT_CONFIRM_PAYLOAD", "FIT_CONFIRM_BODY"],
);
const selectedHotspotId = Number(previewPayload?.selectedHotspotId || DEFAULT_SELECTED_HOTSPOT_ID);

function unwrapJson(value: unknown): any {
  let current = value;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (typeof current !== "string") break;
    const trimmed = current.trim();
    if (!trimmed) return {};
    current = JSON.parse(trimmed);
  }

  return current ?? {};
}

async function postJson(url: string, token: string, body: any) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  const responseJson = unwrapJson(rawText);

  return {
    response,
    rawText,
    responseJson,
  };
}

function getRemovedHotspotIdsFromPayload(payloadLike: any): number[] {
  const ids = [
    ...(Array.isArray(payloadLike?.removedHotspots) ? payloadLike.removedHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedHotspots) ? payloadLike.resolution.removedHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedOptionalHotspots) ? payloadLike.resolution.removedOptionalHotspots : []),
    ...(Array.isArray(payloadLike?.resolution?.removedTopPriorityHotspots) ? payloadLike.resolution.removedTopPriorityHotspots : []),
    ...(Array.isArray(payloadLike?.changesRequiredDisplay?.removedItems) ? payloadLike.changesRequiredDisplay.removedItems : []),
  ]
    .map((row: any) => Number(row?.id || row?.hotspotId || row?.hotspot_ID || 0))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  return Array.from(new Set(ids));
}

function buildConfirmPayload(previewResponse: any): any {
  const previewRemovedHotspotIds = getRemovedHotspotIdsFromPayload(previewResponse);
  const allowTimingRiskFromPreview =
    previewResponse?.requiresTimingRiskConfirmation === true ||
    previewResponse?.timingRisk?.type === "PARTIAL_STAY_AFTER_CLOSING" ||
    previewResponse?.selectedOpeningConflict != null;

  const envAllowTimingRisk = String(process.env.FIT_ALLOW_TIMING_RISK || "").trim().toLowerCase();
  const envAllowPriorityRemoval = String(process.env.FIT_ALLOW_PRIORITY_REMOVAL || "").trim().toLowerCase();
  const envAllowClosedHotspotConflict = String(process.env.FIT_ALLOW_CLOSED_HOTSPOT_CONFLICT || "").trim().toLowerCase();
  const envAckRemovedHotspotIds = String(process.env.FIT_ACK_REMOVED_HOTSPOT_IDS || "").trim();

  const acknowledgeIds = envAckRemovedHotspotIds
    ? envAckRemovedHotspotIds
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((id) => Number.isFinite(id) && id > 0)
    : previewRemovedHotspotIds;

  return {
    ...confirmPayloadTemplate,
    attemptId: String(
      process.env.FIT_CONFIRM_ATTEMPT_ID ||
      previewResponse?.attemptId ||
      confirmPayloadTemplate?.attemptId ||
      DEFAULT_ATTEMPT_ID,
    ).trim(),
    allowTimingRisk:
      envAllowTimingRisk === "true" ||
      (envAllowTimingRisk === "false" ? false : allowTimingRiskFromPreview),
    allowPriorityRemoval:
      envAllowPriorityRemoval === "true" ||
      (envAllowPriorityRemoval === "false" ? false : (
        previewRemovedHotspotIds.length > 0 ||
        confirmPayloadTemplate?.allowPriorityRemoval === true
      )),
    allowClosedHotspotConflict:
      envAllowClosedHotspotConflict === "true" ||
      (envAllowClosedHotspotConflict === "false"
        ? false
        : confirmPayloadTemplate?.allowClosedHotspotConflict === true),
    acknowledgedRemovedHotspotIds: acknowledgeIds.length > 0 ? acknowledgeIds : previewRemovedHotspotIds,
  };
}

function buildConfirmPayloadWithoutPreview(): any {
  const envAllowTimingRisk = String(process.env.FIT_ALLOW_TIMING_RISK || "").trim().toLowerCase();
  const envAllowPriorityRemoval = String(process.env.FIT_ALLOW_PRIORITY_REMOVAL || "").trim().toLowerCase();
  const envAllowClosedHotspotConflict = String(process.env.FIT_ALLOW_CLOSED_HOTSPOT_CONFLICT || "").trim().toLowerCase();
  const envAckRemovedHotspotIds = String(process.env.FIT_ACK_REMOVED_HOTSPOT_IDS || "").trim();

  const acknowledgeIds = envAckRemovedHotspotIds
    ? envAckRemovedHotspotIds
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((id) => Number.isFinite(id) && id > 0)
    : getRemovedHotspotIdsFromPayload(confirmPayloadTemplate);

  return {
    ...confirmPayloadTemplate,
    attemptId: String(
      process.env.FIT_CONFIRM_ATTEMPT_ID ||
      confirmPayloadTemplate?.attemptId ||
      DEFAULT_ATTEMPT_ID,
    ).trim(),
    allowTimingRisk:
      envAllowTimingRisk === "true" ||
      (envAllowTimingRisk === "false" ? false : confirmPayloadTemplate?.allowTimingRisk === true),
    allowPriorityRemoval:
      envAllowPriorityRemoval === "true" ||
      (envAllowPriorityRemoval === "false" ? false : (
        acknowledgeIds.length > 0 ||
        confirmPayloadTemplate?.allowPriorityRemoval === true
      )),
    allowClosedHotspotConflict:
      envAllowClosedHotspotConflict === "true" ||
      (envAllowClosedHotspotConflict === "false"
        ? false
        : confirmPayloadTemplate?.allowClosedHotspotConflict === true),
    acknowledgedRemovedHotspotIds: acknowledgeIds,
  };
}

function getHotspotId(row: any): number {
  return Number(
    row?.hotspotId ||
    row?.hotspot_ID ||
    row?.hotspot_id ||
    row?.locationId ||
    row?.id ||
    0,
  );
}

function getRowType(row: any): string {
  return String(row?.type || row?.itemType || "").trim().toLowerCase();
}

function getRowName(row: any): string {
  return String(
    row?.name ||
    row?.hotspotName ||
    row?.hotspot_name ||
    row?.text ||
    "",
  ).trim();
}

function parseClockToMinutes(value: string): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s*\+\d+d$/i, "").trim();

  const meridiemMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (meridiemMatch) {
    let hours = Number(meridiemMatch[1]);
    const minutes = Number(meridiemMatch[2]);
    const meridiem = meridiemMatch[3].toUpperCase();

    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    if (meridiem === "AM" && hours === 12) hours = 0;
    if (meridiem === "PM" && hours !== 12) hours += 12;

    return (hours * 60) + minutes;
  }

  const twentyFourHourMatch = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    const hours = Number(twentyFourHourMatch[1]);
    const minutes = Number(twentyFourHourMatch[2]);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return (hours * 60) + minutes;
  }

  return null;
}

function parseTimeRange(value: string): { start: number | null; end: number | null } {
  const raw = String(value || "").trim();
  if (!raw) return { start: null, end: null };

  const [startText, endText] = raw.split(/\s*-\s*/);
  const start = parseClockToMinutes(startText || "");
  let end = parseClockToMinutes(endText || "");

  if (start != null && end != null && end < start) {
    end += 1440;
  }

  return { start, end };
}

function extractOperatingWindows(label: string): Array<{ start: number; end: number }> {
  const raw = String(label || "").trim();
  if (!raw) return [];
  if (/^closed$/i.test(raw)) return [];
  if (/open\s*24/i.test(raw)) return [{ start: 0, end: 1440 }];

  return raw
    .split(",")
    .map((part) => {
      const [startText, endText] = String(part).split(/\s*-\s*/);
      const start = parseClockToMinutes(startText || "");
      let end = parseClockToMinutes(endText || "");

      if (start == null || end == null) return null;
      if (end < start) end += 1440;

      return { start, end };
    })
    .filter((window): window is { start: number; end: number } => Boolean(window));
}

function evaluateTimeRangeAgainstOperatingHours(timeRange: string, operatingHours: string) {
  const attempted = parseTimeRange(timeRange);
  const windows = extractOperatingWindows(operatingHours);

  if (attempted.start == null || attempted.end == null) {
    return {
      fitsWithinOperatingHours: null,
      overflowMinutes: null,
      parsedAttempt: attempted,
      windows,
    };
  }

  if (windows.length === 0) {
    return {
      fitsWithinOperatingHours: false,
      overflowMinutes: null,
      parsedAttempt: attempted,
      windows,
    };
  }

  for (const window of windows) {
    if (attempted.start >= window.start && attempted.end <= window.end) {
      return {
        fitsWithinOperatingHours: true,
        overflowMinutes: 0,
        parsedAttempt: attempted,
        windows,
      };
    }
  }

  let overflowMinutes: number | null = null;
  for (const window of windows) {
    if (attempted.start >= window.start) {
      const overflow = attempted.end - window.end;
      if (overflowMinutes == null || Math.abs(overflow) < Math.abs(overflowMinutes)) {
        overflowMinutes = overflow;
      }
    }
  }

  return {
    fitsWithinOperatingHours: false,
    overflowMinutes,
    parsedAttempt: attempted,
    windows,
  };
}

function isAttractionRow(row: any): boolean {
  return getRowType(row) === "attraction" || Number(row?.item_type || 0) === 4;
}

function findSelectedAttractionRow(rows: any[]): any | null {
  return (
    rows.find((row: any) => isAttractionRow(row) && getHotspotId(row) === selectedHotspotId) ||
    rows.find((row: any) => isAttractionRow(row) && /apj/i.test(getRowName(row))) ||
    null
  );
}

function summarizeSelectedRow(row: any, source: string) {
  if (!row) {
    return {
      source,
      present: false,
    };
  }

  const timeRange = String(
    row?.timeRange ||
    row?.visitTime ||
    row?.attemptedVisitTime ||
    "",
  ).trim();
  const operatingHours = String(
    row?.operatingHours ||
    row?.timings ||
    row?.selectedOpeningConflict?.operatingHours ||
    "",
  ).trim();
  const operatingCheck = evaluateTimeRangeAgainstOperatingHours(timeRange, operatingHours);

  return {
    source,
    present: true,
    hotspotId: getHotspotId(row),
    hotspotName: getRowName(row),
    timeRange,
    operatingHours: operatingHours || null,
    fitsWithinOperatingHours: operatingCheck.fitsWithinOperatingHours,
    overflowMinutes: operatingCheck.overflowMinutes,
    isConflict: row?.isConflict === true || row?.is_conflict === 1,
    conflictReason: row?.conflictReason || row?.conflict_reason || null,
    selectedOpeningConflict: row?.selectedOpeningConflict || null,
  };
}

function collectTimelineChecks(responseJson: any) {
  const sources: Array<{ source: string; rows: any[] }> = [];

  const pushIfArray = (source: string, value: any) => {
    if (!Array.isArray(value) || value.length === 0) return;
    sources.push({ source, rows: value });
  };

  pushIfArray("routeTimeline", responseJson?.routeTimeline);
  pushIfArray("finalizedTimeline", responseJson?.finalizedTimeline);
  pushIfArray("proposedTimeline", responseJson?.proposedTimeline);
  pushIfArray("fullTimeline", responseJson?.fullTimeline);
  pushIfArray("resolution.routeTimeline", responseJson?.resolution?.routeTimeline);
  pushIfArray("resolution.fullTimeline", responseJson?.resolution?.fullTimeline);

  return sources.map(({ source, rows }) => summarizeSelectedRow(findSelectedAttractionRow(rows), source));
}

function getAttemptTimeline(attempt: any): any[] {
  const candidate =
    (Array.isArray(attempt?.previewTimelineDisplay) && attempt.previewTimelineDisplay.length > 0
      ? attempt.previewTimelineDisplay
      : null) ||
    (Array.isArray(attempt?.displayTimeline) && attempt.displayTimeline.length > 0
      ? attempt.displayTimeline
      : null) ||
    (Array.isArray(attempt?.previewTimeline) && attempt.previewTimeline.length > 0
      ? attempt.previewTimeline
      : null) ||
    (Array.isArray(attempt?.computedTimelineDebug) && attempt.computedTimelineDebug.length > 0
      ? attempt.computedTimelineDebug
      : []);

  return Array.isArray(candidate) ? candidate : [];
}

function collectResolvedAttemptChecks(responseJson: any) {
  const plans = [
    responseJson?.manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview,
    responseJson?.resolution?.manualInsertionFit?.lowPriorityOpeningHoursRemovalPlanPreview,
    responseJson?.manualInsertionFit?.lowPriorityRemovalPlanPreview,
    responseJson?.resolution?.manualInsertionFit?.lowPriorityRemovalPlanPreview,
  ].filter(Boolean);

  const checks: any[] = [];

  for (const plan of plans) {
    const attempts = Array.isArray(plan?.simulationAttempts) ? plan.simulationAttempts : [];
    for (const attempt of attempts) {
      const timeline = getAttemptTimeline(attempt);
      if (timeline.length === 0) continue;

      const rowSummary = summarizeSelectedRow(
        findSelectedAttractionRow(timeline),
        `attempt:${String(attempt?.strategy || attempt?.strategyKey || "unknown")}`,
      );

      checks.push({
        strategy: attempt?.strategy || attempt?.strategyKey || null,
        resolved: attempt?.resolved === true || attempt?.valid === true,
        selectedOpeningConflict: attempt?.selectedOpeningConflict || null,
        selectedClosingOverflowMinutes: Number(attempt?.selectedClosingOverflowMinutes || 0),
        ...rowSummary,
      });
    }
  }

  return checks;
}

function findTravelRow(rows: any[], fromName: string, toName: string): any | null {
  return rows.find((row: any) => {
    if (getRowType(row) !== "travel") return false;
    const rowFrom = String(row?.fromName || row?.displayFromName || row?.from || "").trim().toLowerCase();
    const rowTo = String(row?.toName || row?.displayToName || row?.to || "").trim().toLowerCase();
    return rowFrom === fromName.trim().toLowerCase() && rowTo === toName.trim().toLowerCase();
  }) || null;
}

function summarizeTravelReplicaRow(row: any) {
  if (!row) return null;

  return {
    fromHotspotId: Number(row?.fromHotspotId || 0) || null,
    toHotspotId: Number(row?.toHotspotId || 0) || null,
    fromName: String(row?.fromName || row?.displayFromName || row?.from || "").trim() || null,
    toName: String(row?.toName || row?.displayToName || row?.to || "").trim() || null,
    source: row?.isMainTimelineTravelReplica === true ? "MAIN_TIMELINE_REPLICA" : "MATRIX_FALLBACK",
    durationMin: Number(row?.matrixDurationMin || row?.durationMinutes || 0) || null,
    distanceKm: Number(row?.matrixDistanceKm || row?.distanceKm || row?.travelDistanceKm || 0) || null,
    timeRange: String(row?.timeRange || "").trim() || null,
    originalTimeRange: row?.originalTimeRange || null,
    isMainTimelineTravelReplica: row?.isMainTimelineTravelReplica === true,
  };
}

async function loginAndGetToken(): Promise<string> {
  const existingToken = String(
    process.env.FIT_PREVIEW_TOKEN ||
    process.env.FIT_TOKEN ||
    "",
  ).trim();
  if (existingToken) return existingToken;

  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${await response.text()}`);
  }

  const json = unwrapJson(await response.text());
  const token = String(json?.accessToken || json?.token || "").trim();
  if (!token) {
    throw new Error("Login succeeded but no access token was returned.");
  }

  return token;
}

async function main() {
  const token = await loginAndGetToken();
  const outDir = path.join("tmp");
  fs.mkdirSync(outDir, { recursive: true });

  let previewJson: any = null;
  let previewTimelineChecks: any[] = [];
  let previewPrimaryTimelineCheck: any = null;
  let previewRows: any[] = [];
  let previewSummary: any = {
    request: {
      mode: "preview",
      url: PREVIEW_URL,
      payload: previewPayload,
    },
    skipped: SKIP_PREVIEW,
  };

  if (!SKIP_PREVIEW) {
    const previewCall = await postJson(PREVIEW_URL, token, previewPayload);
    const previewRawOutPath = path.join(outDir, "fit-preview-plan9774-route7761-apj.preview.raw.json");
    const previewParsedOutPath = path.join(outDir, "fit-preview-plan9774-route7761-apj.preview.parsed.json");
    fs.writeFileSync(previewRawOutPath, previewCall.rawText);
    fs.writeFileSync(previewParsedOutPath, JSON.stringify(previewCall.responseJson, null, 2));

    if (!previewCall.response.ok) {
      console.error(previewCall.rawText);
      throw new Error(`Fit preview failed: ${previewCall.response.status}`);
    }

    previewJson = previewCall.responseJson;
    previewTimelineChecks = collectTimelineChecks(previewJson);
    previewPrimaryTimelineCheck =
      previewTimelineChecks.find((check: any) => check.source === "routeTimeline" && check.present) ||
      previewTimelineChecks.find((check: any) => check.source === "finalizedTimeline" && check.present) ||
      previewTimelineChecks.find((check: any) => check.source === "proposedTimeline" && check.present) ||
      previewTimelineChecks.find((check: any) => check.present) ||
      null;

    previewRows =
      (Array.isArray(previewJson?.routeTimeline) && previewJson.routeTimeline) ||
      (Array.isArray(previewJson?.finalizedTimeline) && previewJson.finalizedTimeline) ||
      (Array.isArray(previewJson?.proposedTimeline) && previewJson.proposedTimeline) ||
      (Array.isArray(previewJson?.fullTimeline) && previewJson.fullTimeline) ||
      (Array.isArray(previewJson?.resolution?.routeTimeline) && previewJson.resolution.routeTimeline) ||
      (Array.isArray(previewJson?.resolution?.fullTimeline) && previewJson.resolution.fullTimeline) ||
      [];
    const previewTravelReplicas = {
      thirumalaiToRamanatha: summarizeTravelReplicaRow(
        findTravelRow(previewRows, "Thirumalai Nayakkar Mahal", "Ramanatha swami Temple"),
      ),
      meenakshiToRamanatha: summarizeTravelReplicaRow(
        findTravelRow(previewRows, "Meenakshi Amman Temple", "Ramanatha swami Temple"),
      ),
      ramanathaToApj: summarizeTravelReplicaRow(
        findTravelRow(previewRows, "Ramanatha swami Temple", "APJ Abdul Kalam National Memorial"),
      ),
    };

    previewSummary = {
      request: {
        mode: "preview",
        url: PREVIEW_URL,
        payload: previewPayload,
      },
      response: {
        attemptId: previewJson?.attemptId || null,
        resultType: previewJson?.resultType || null,
        canConfirm: previewJson?.canConfirm ?? null,
        requiresTimingRiskConfirmation: previewJson?.requiresTimingRiskConfirmation ?? null,
        confirmButtonVariant: previewJson?.confirmButtonVariant || null,
        selectedOpeningConflict: previewJson?.selectedOpeningConflict || null,
        validationSelectedOpeningConflict: previewJson?.validation?.selectedOpeningConflict || null,
        timingRisk: previewJson?.timingRisk || null,
        validationReason: previewJson?.validation?.reason || null,
      },
      timelineChecks: previewTimelineChecks,
      travelReplicas: previewTravelReplicas,
      outputFiles: {
        raw: path.join(outDir, "fit-preview-plan9774-route7761-apj.preview.raw.json"),
        parsed: path.join(outDir, "fit-preview-plan9774-route7761-apj.preview.parsed.json"),
      },
    };

    if (FIT_MODE === "preview") {
      console.log(JSON.stringify(previewSummary, null, 2));

      const previewFailures: string[] = [];
      if (!previewPrimaryTimelineCheck?.present) {
        previewFailures.push("APJ attraction row is missing from the preview timelines.");
      }
      if (previewJson?.canConfirm !== true) {
        previewFailures.push("API did not mark the preview as confirmable.");
      }
      if (!previewPrimaryTimelineCheck || previewPrimaryTimelineCheck.fitsWithinOperatingHours !== true) {
        previewFailures.push(
          `APJ is not inside operating hours on ${String(previewPrimaryTimelineCheck?.source || "preview timeline")} (${String(previewPrimaryTimelineCheck?.timeRange || "missing time")} vs ${String(previewPrimaryTimelineCheck?.operatingHours || "missing operating hours")}).`,
        );
      }

      if (previewFailures.length > 0) {
        console.error("\nValidation failures:");
        for (const failure of previewFailures) {
          console.error(`- ${failure}`);
        }
        process.exit(1);
      }

      console.log("\nAPJ preview is confirmable and inside operating hours.");
      console.log(`Saved preview raw response to ${previewSummary.outputFiles.raw}`);
      console.log(`Saved preview parsed response to ${previewSummary.outputFiles.parsed}`);
      return;
    }
  }

  const confirmPayload = SKIP_PREVIEW
    ? buildConfirmPayloadWithoutPreview()
    : buildConfirmPayload(previewJson);
  const confirmCall = await postJson(CONFIRM_URL, token, confirmPayload);
  const confirmRawOutPath = path.join(outDir, "fit-confirm-plan9774-route7761-apj.raw.json");
  const confirmParsedOutPath = path.join(outDir, "fit-confirm-plan9774-route7761-apj.parsed.json");
  fs.writeFileSync(confirmRawOutPath, confirmCall.rawText);
  fs.writeFileSync(confirmParsedOutPath, JSON.stringify(confirmCall.responseJson, null, 2));

  const confirmJson = confirmCall.responseJson;
  const confirmAlreadyApplied = (
    confirmCall.response.status === 409
    && confirmJson?.applyCode === "MANUAL_HOTSPOT_ALREADY_EXISTS_IN_ROUTE"
  );

  if (!confirmCall.response.ok && !confirmAlreadyApplied) {
    console.error(confirmCall.rawText);
    throw new Error(`Fit confirm failed: ${confirmCall.response.status}`);
  }

  const confirmTimelineChecks = collectTimelineChecks(confirmJson);
  const confirmPrimaryTimelineCheck =
    confirmTimelineChecks.find((check: any) => check.source === "routeTimeline" && check.present) ||
    confirmTimelineChecks.find((check: any) => check.source === "finalizedTimeline" && check.present) ||
    confirmTimelineChecks.find((check: any) => check.source === "proposedTimeline" && check.present) ||
    confirmTimelineChecks.find((check: any) => check.present) ||
    null;

  const confirmRows =
    (Array.isArray(confirmJson?.routeTimeline) && confirmJson.routeTimeline) ||
    (Array.isArray(confirmJson?.fullTimeline) && confirmJson.fullTimeline) ||
    (Array.isArray(confirmJson?.finalizedTimeline) && confirmJson.finalizedTimeline) ||
    (Array.isArray(confirmJson?.resolution?.routeTimeline) && confirmJson.resolution.routeTimeline) ||
    (Array.isArray(confirmJson?.resolution?.fullTimeline) && confirmJson.resolution.fullTimeline) ||
    previewRows;
  const confirmTravelReplicas = {
    thirumalaiToRamanatha: summarizeTravelReplicaRow(
      findTravelRow(confirmRows, "Thirumalai Nayakkar Mahal", "Ramanatha swami Temple"),
    ),
    meenakshiToRamanatha: summarizeTravelReplicaRow(
      findTravelRow(confirmRows, "Meenakshi Amman Temple", "Ramanatha swami Temple"),
    ),
    ramanathaToApj: summarizeTravelReplicaRow(
      findTravelRow(confirmRows, "Ramanatha swami Temple", "APJ Abdul Kalam National Memorial"),
    ),
  };
  const confirmResolvedAttemptChecks = collectResolvedAttemptChecks(confirmJson).filter((check: any) => check.resolved === true);
  const confirmValidResolvedAttempts = confirmResolvedAttemptChecks.filter((check: any) => (
    check.present === true
    && check.fitsWithinOperatingHours === true
    && !check.selectedOpeningConflict
    && !check.isConflict
    && Number(check.selectedClosingOverflowMinutes || 0) <= 0
  ));

  const summary = {
    request: {
      mode: FIT_MODE,
      previewUrl: PREVIEW_URL,
      confirmUrl: CONFIRM_URL,
      previewPayload,
      confirmPayload,
    },
    preview: previewSummary,
    confirm: {
      status: confirmCall.response.status,
      attemptId: confirmJson?.attemptId || null,
      success: confirmJson?.success ?? null,
      inserted: confirmJson?.inserted ?? null,
      applyCode: confirmJson?.applyCode || null,
      selectedHotspotId: confirmJson?.selectedHotspotId ?? null,
      routeId: confirmJson?.routeId ?? null,
      routeHotspotId: confirmJson?.routeHotspotId ?? null,
      selectedOpeningConflict: confirmJson?.selectedOpeningConflict || null,
      validationSelectedOpeningConflict: confirmJson?.validation?.selectedOpeningConflict || null,
      validationReason: confirmJson?.validation?.reason || null,
    },
    timelineChecks: confirmTimelineChecks,
    travelReplicas: confirmTravelReplicas,
    resolvedAttemptChecks: confirmResolvedAttemptChecks,
    validResolvedAttempts: confirmValidResolvedAttempts,
    outputFiles: {
      previewRaw: previewRawOutPath,
      previewParsed: previewParsedOutPath,
      confirmRaw: confirmRawOutPath,
      confirmParsed: confirmParsedOutPath,
    },
  };

  console.log(JSON.stringify(summary, null, 2));

  const failures: string[] = [];

  if (!previewPrimaryTimelineCheck?.present) {
    failures.push("APJ attraction row is missing from the preview timelines.");
  }
  if (previewJson?.canConfirm !== true) {
    failures.push("API did not mark the preview as confirmable.");
  }
  if (previewJson?.selectedOpeningConflict) {
    failures.push(
      `Preview still reports a selectedOpeningConflict: ${String(previewJson?.selectedOpeningConflict?.attemptedVisitTime || previewJson?.selectedOpeningConflict?.reason || "unknown conflict")}`,
    );
  }
  if (!previewPrimaryTimelineCheck || previewPrimaryTimelineCheck.fitsWithinOperatingHours !== true) {
    failures.push(
      `APJ is not inside operating hours on preview timeline (${String(previewPrimaryTimelineCheck?.timeRange || "missing time")} vs ${String(previewPrimaryTimelineCheck?.operatingHours || "missing operating hours")}).`,
    );
  }
  if (previewPrimaryTimelineCheck?.isConflict) {
    failures.push(
      `APJ row is still marked as conflict on the preview timeline: ${String(previewPrimaryTimelineCheck?.conflictReason || "unknown reason")}`,
    );
  }
  if (confirmJson?.success !== true || confirmJson?.inserted !== true) {
    if (confirmAlreadyApplied) {
      console.log("\nConfirm step reported the hotspot already exists in the route; treating this as already applied.");
    } else {
      failures.push("Fit confirm did not return a successful inserted result.");
    }
  }
  if (!confirmAlreadyApplied && !confirmPrimaryTimelineCheck?.present) {
    failures.push("APJ attraction row is missing from the confirmed timelines.");
  }
  if (!confirmAlreadyApplied && confirmJson?.selectedOpeningConflict) {
    failures.push(
      `Confirmed response still reports a selectedOpeningConflict: ${String(confirmJson?.selectedOpeningConflict?.attemptedVisitTime || confirmJson?.selectedOpeningConflict?.reason || "unknown conflict")}`,
    );
  }
  if (!confirmAlreadyApplied && !confirmTravelReplicas.ramanathaToApj) {
    failures.push("Could not find the Ramanatha swami Temple -> APJ Abdul Kalam National Memorial travel row in the confirmed timeline.");
  } else if (!confirmAlreadyApplied && confirmTravelReplicas.ramanathaToApj.source !== "MAIN_TIMELINE_REPLICA") {
    failures.push(
      `Ramanatha -> APJ travel row was rebuilt from ${confirmTravelReplicas.ramanathaToApj.source} instead of reusing the main timeline replica.`,
    );
  }
  if (!confirmAlreadyApplied && confirmTravelReplicas.thirumalaiToRamanatha && confirmTravelReplicas.thirumalaiToRamanatha.source !== "MAIN_TIMELINE_REPLICA") {
    failures.push(
      `Thirumalai -> Ramanatha travel row was rebuilt from ${confirmTravelReplicas.thirumalaiToRamanatha.source} instead of reusing the main timeline replica.`,
    );
  }

  if (failures.length > 0) {
    console.error("\nValidation failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }

    if (confirmValidResolvedAttempts.length > 0) {
      console.error("\nResolved attempt(s) that already place APJ inside operating hours:");
      for (const attempt of confirmValidResolvedAttempts) {
        console.error(
          `- ${attempt.strategy}: ${attempt.timeRange} within ${attempt.operatingHours} (${attempt.source})`,
        );
      }
    }

    process.exit(1);
  }

  console.log("\nAPJ preview was confirmed successfully.");
  console.log(`Saved preview raw response to ${previewRawOutPath}`);
  console.log(`Saved preview parsed response to ${previewParsedOutPath}`);
  console.log(`Saved confirm raw response to ${confirmRawOutPath}`);
  console.log(`Saved confirm parsed response to ${confirmParsedOutPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
