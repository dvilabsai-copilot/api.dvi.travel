import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const API_BASE_URL =
  process.env.FIT_PREVIEW_URL ||
  "http://127.0.0.1:4006/api/v1/itineraries/9706/manual-hotspot/fit-preview";
const LOGIN_URL =
  process.env.FIT_LOGIN_URL ||
  "http://127.0.0.1:4006/api/v1/auth/login";

const USER_EMAIL = process.env.FIT_USER_EMAIL || "admin@dvi.co.in";
const USER_PASSWORD = process.env.FIT_USER_PASSWORD || "Keerthi@2404ias";

const PLAN_ID = 9706;
const ROUTE_ID = 7194;
const SELECTED_HOTSPOT_ID = 42;
const ALAGAR_KOYIL_ID = 28;
const FLOWER_MARKET_ID = 894;
const ARIYAMAAN_ID = 636;

const payload = {
  routeId: ROUTE_ID,
  selectedHotspotId: SELECTED_HOTSPOT_ID,
  anchor: {
    anchorType: "BETWEEN_ROWS",
    anchorIntent: "AFTER_ATTRACTION",
    anchorIndex: 7,
    anchorFrom: "Flower market Madurai",
    anchorTo: "Ariyamaan Beach (Kushi Beach)",
    anchorLabel: "After Flower market Madurai",
    afterRowType: "attraction",
    beforeRowType: "attraction",
    afterHotspotId: FLOWER_MARKET_ID,
    beforeHotspotId: ARIYAMAAN_ID,
    afterRouteHotspotId: 186397,
    beforeRouteHotspotId: 187340,
    isBeforeHotel: false,
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};

const getHotspotId = (row: any): number =>
  Number(row?.hotspotId || row?.hotspot_ID || row?.hotspot_id || row?.locationId || row?.id || 0);

const getRowName = (row: any): string =>
  String(row?.name || row?.hotspotName || row?.hotspot_name || row?.text || "");

const allAttemptsOf = (plan: any): any[] => [
  ...(Array.isArray(plan?.simulationAttempts) ? plan.simulationAttempts : []),
  ...(Array.isArray(plan?.rejectedAttempts) ? plan.rejectedAttempts : []),
];

async function loginAndGetToken(): Promise<string> {
  if (process.env.FIT_TOKEN) return String(process.env.FIT_TOKEN);

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

  const json = (await response.json()) as { accessToken?: string };
  const token = String(json?.accessToken || "").trim();
  if (!token) {
    throw new Error("Login succeeded but no accessToken was returned.");
  }

  return token;
}

async function main() {
  const token = await loginAndGetToken();

  const response = await fetch(API_BASE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  const rawOutPath = path.join("tmp", "fit-preview-route-7194-dhanushkodi.json");
  fs.mkdirSync(path.dirname(rawOutPath), { recursive: true });
  fs.writeFileSync(rawOutPath, JSON.stringify(json, null, 2));

  if (!response.ok) {
    console.error(text);
    throw new Error(`Fit preview failed: ${response.status}`);
  }

  const plan =
    json?.resolution?.manualInsertionFit?.lowPriorityRemovalPlanPreview ||
    json?.manualInsertionFit?.lowPriorityRemovalPlanPreview ||
    null;
  const attempts = allAttemptsOf(plan);
  const candidateIds = Array.isArray(plan?.candidates)
    ? plan.candidates.map((row: any) => Number(row?.id || 0))
    : [];
  const proposedTimeline = Array.isArray(json?.proposedTimeline) ? json.proposedTimeline : [];
  const selectedRows = proposedTimeline.filter((row: any) => getHotspotId(row) === SELECTED_HOTSPOT_ID);
  const selectedAttractionRow = selectedRows.find((row: any) => String(row?.type || "").toLowerCase() === "attraction") || null;
  const removedHotspotIds = [
    ...(Array.isArray(json?.removedHotspots) ? json.removedHotspots : []),
    ...(Array.isArray(json?.resolution?.removedHotspots) ? json.resolution.removedHotspots : []),
  ].map((row: any) => getHotspotId(row)).filter((id: number) => id > 0);

  const attemptSummary = attempts.map((attempt: any) => ({
    removedHotspotIds: Array.isArray(attempt?.removedHotspotIds) ? attempt.removedHotspotIds.map(Number) : [],
    resolved: attempt?.resolved === true || attempt?.valid === true,
    selectedTime:
      attempt?.selectedAttemptedVisitTime ||
      (
        Array.isArray(attempt?.previewTimelineDisplay)
          ? attempt.previewTimelineDisplay.find((row: any) => getHotspotId(row) === SELECTED_HOTSPOT_ID)?.timeRange
          : null
      ) ||
      null,
  }));

  const concise = {
    planId: PLAN_ID,
    routeId: ROUTE_ID,
    resultType: json?.resultType,
    canConfirm: json?.canConfirm,
    rejectedReason: Array.isArray(json?.rejectedReasons) ? json.rejectedReasons[0] : null,
    proposedTimelineSelectedRows: selectedRows.map((row: any) => ({
      type: row?.type,
      name: getRowName(row),
      timeRange: row?.timeRange,
      isManual: row?.isManual,
      isConflict: row?.isConflict,
    })),
    removalPlan: {
      resolved: plan?.resolved === true,
      message: plan?.message || null,
      candidateIds,
      candidateNames: Array.isArray(plan?.candidates) ? plan.candidates.map((row: any) => getRowName(row)) : [],
      attempts: attemptSummary,
    },
  };

  console.log(JSON.stringify(concise, null, 2));

  const failures: string[] = [];

  if (!selectedAttractionRow) {
    failures.push("Dhanushkodi attraction row is missing from proposedTimeline.");
  }
  if (removedHotspotIds.includes(SELECTED_HOTSPOT_ID)) {
    failures.push("Selected Dhanushkodi hotspot appears in removedHotspots.");
  }
  if (removedHotspotIds.includes(ARIYAMAAN_ID)) {
    failures.push("Manual Ariyamaan hotspot appears in removedHotspots.");
  }
  if (json?.canConfirm !== true) {
    failures.push("Exact-anchor Dhanushkodi-after-Flower preview should now be confirmable.");
  }
  if (String(json?.resultType || "") !== "FITS_DIRECTLY") {
    failures.push("Exact-anchor Dhanushkodi-after-Flower preview should be FITS_DIRECTLY.");
  }
  if (candidateIds.includes(ARIYAMAAN_ID)) {
    failures.push("Manual Ariyamaan should never appear in removal candidates.");
  }
  if (attemptSummary.length > 0) {
    failures.push("This exact-anchor path should not need rescue attempts after the fix.");
  }

  if (failures.length > 0) {
    console.error("\nValidation failures:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`\nSaved raw response to ${rawOutPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
