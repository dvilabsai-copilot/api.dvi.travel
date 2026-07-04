import "dotenv/config";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

type PreviewPayload = {
  routeId: number;
  selectedHotspotId: number;
  anchor?: Record<string, any>;
  allowP3Removal?: boolean;
  allowP1P2Removal?: boolean;
  [key: string]: any;
};

type ConfirmPayload = {
  attemptId: string;
  allowTimingRisk?: boolean;
  allowClosedHotspotConflict?: boolean;
  allowPriorityRemoval?: boolean;
  acknowledgedRemovedHotspotIds?: number[];
};

type ParsedArgs = {
  planId: number;
  routeId: number;
  selectedHotspotId: number;
  previewPayload: PreviewPayload | null;
  confirmPayload: ConfirmPayload | null;
  baseUrl: string;
  inputMode: "none" | "file" | "clipboard";
  inputPath: string | null;
  showHelp: boolean;
};

const DEFAULT_BASE_URL = process.env.FIT_BASE_URL || "http://127.0.0.1:4006/api/v1";
const DEFAULT_PLAN_ID = 9798;
const DEFAULT_ROUTE_ID = 7949;
const DEFAULT_SELECTED_HOTSPOT_ID = 319;

const DEFAULT_PREVIEW_PAYLOAD: PreviewPayload = {
  routeId: DEFAULT_ROUTE_ID,
  selectedHotspotId: DEFAULT_SELECTED_HOTSPOT_ID,
  anchor: {
    anchorType: "BETWEEN_ROWS",
    anchorIntent: "AFTER_ATTRACTION",
    anchorIndex: 3,
    anchorFrom: "Arulmigu Arunachaleswarar Temple",
    anchorTo: "Virupaksha Cave",
    anchorLabel: "After Arulmigu Arunachaleswarar Temple",
    anchorTimeRange: "07:06 AM - 09:06 AM",
    afterRowType: "attraction",
    beforeRowType: "hotspot",
    afterHotspotId: 458,
    afterRouteHotspotId: 131916,
    beforeHotspotId: 699,
    beforeRouteHotspotId: 131923,
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};

const DEFAULT_CONFIRM_PAYLOAD: ConfirmPayload = {
  attemptId: "",
  allowTimingRisk: false,
  allowClosedHotspotConflict: false,
  allowPriorityRemoval: true,
  acknowledgedRemovedHotspotIds: [458],
};

function toInt(raw: any, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function parseJson(raw: string | undefined): any | null {
  if (!raw || !String(raw).trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (error: any) {
    throw new Error(`Invalid JSON: ${error?.message || error}`);
  }
}

function readClipboardText(): string {
  if (process.platform !== "win32") {
    throw new Error("Clipboard mode is only supported on Windows in this workspace.");
  }

  return String(execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], {
    encoding: "utf8",
  }) || "");
}

function normalizeInputObject(raw: any): {
  planId?: number;
  routeId?: number;
  selectedHotspotId?: number;
  previewPayload?: PreviewPayload;
  confirmPayload?: ConfirmPayload;
} {
  if (!raw || typeof raw !== "object") return {};

  if (raw.previewPayload || raw.confirmPayload || raw.planId || raw.routeId || raw.selectedHotspotId) {
    return raw;
  }

  return { previewPayload: raw };
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run debug:fit-here:replay -- --inputFile ./payload.json",
    "  npm run debug:fit-here:replay -- --clipboard",
    "",
    "Input file format:",
    "  {",
    "    \"planId\": 9798,",
    "    \"routeId\": 7949,",
    "    \"selectedHotspotId\": 319,",
    "    \"previewPayload\": { ... },",
    "    \"confirmPayload\": { ... }",
    "  }",
    "",
    "If the input JSON is just a preview payload, the script will treat it as previewPayload.",
  ].join("\n"));
}

async function parseArgs(): Promise<ParsedArgs> {
  const argv = process.argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    if (token.includes("=")) {
      const [key, value] = token.slice(2).split("=", 2);
      parsed[key] = String(value || "").trim();
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = String(next).trim();
      i += 1;
    } else {
      parsed[key] = "true";
    }
  }

  const inputMode = parsed.clipboard === "true" || parsed.clipboard === "1"
    ? "clipboard"
    : (parsed.inputFile || parsed.input || process.env.FIT_INPUT_FILE || process.env.FIT_INPUT === "clipboard")
      ? "file"
      : "none";
  const inputPath = String(parsed.inputFile || parsed.input || process.env.FIT_INPUT_FILE || "").trim() || null;

  let inputObject: any = null;
  if (inputMode === "file" && inputPath && inputPath.toLowerCase() !== "clipboard") {
    const resolvedPath = inputPath;
    const rawText = await readFile(resolvedPath, "utf8");
    inputObject = parseJson(rawText);
  } else if (inputMode === "clipboard") {
    inputObject = parseJson(readClipboardText());
  }
  const normalizedInput = normalizeInputObject(inputObject);

  const planId = toInt(
    parsed.planId ||
    normalizedInput.planId ||
    process.env.PLAN_ID,
    DEFAULT_PLAN_ID,
  );
  const routeId = toInt(
    parsed.routeId ||
    normalizedInput.routeId ||
    process.env.ROUTE_ID,
    DEFAULT_ROUTE_ID,
  );
  const selectedHotspotId = toInt(
    parsed.selectedHotspotId ||
    normalizedInput.selectedHotspotId ||
    process.env.SELECTED_HOTSPOT_ID,
    DEFAULT_SELECTED_HOTSPOT_ID,
  );
  const baseUrl = String(parsed.baseUrl || process.env.FIT_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

  const previewPayload =
    parseJson(parsed.previewPayload || process.env.FIT_PREVIEW_PAYLOAD) ||
    normalizedInput.previewPayload ||
    JSON.parse(JSON.stringify(DEFAULT_PREVIEW_PAYLOAD));

  const confirmPayload =
    parseJson(parsed.confirmPayload || process.env.FIT_CONFIRM_PAYLOAD) ||
    normalizedInput.confirmPayload ||
    JSON.parse(JSON.stringify(DEFAULT_CONFIRM_PAYLOAD));

  const showHelp =
    parsed.help === "true" ||
    parsed.help === "1" ||
    parsed.h === "true" ||
    parsed.h === "1";

  return {
    planId,
    routeId,
    selectedHotspotId,
    previewPayload,
    confirmPayload,
    baseUrl,
    inputMode,
    inputPath,
    showHelp,
  };
}

async function loginAndGetToken(baseUrl: string): Promise<string> {
  const existing = String(process.env.DVI_TEST_TOKEN || process.env.FIT_TOKEN || "").trim();
  if (existing) return existing;

  const email = String(process.env.LOGIN_EMAIL || "admin@dvi.co.in").trim();
  const password = String(process.env.LOGIN_PASSWORD || "Keerthi@2404ias").trim();

  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const token =
    body?.accessToken ||
    body?.token ||
    body?.data?.accessToken ||
    body?.data?.token ||
    "";

  if (!token) {
    throw new Error("Login succeeded but no token was returned.");
  }

  return String(token);
}

async function postJson(baseUrl: string, token: string, path: string, payload: any) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }

  return { response, body, text };
}

function compactPreviewResponse(body: any) {
  return {
    attemptId: body?.attemptId || null,
    code: body?.code || null,
    message: body?.message || null,
    canConfirm: body?.canConfirm ?? null,
    resultType: body?.resultType || null,
    selectedOpeningConflict: body?.selectedOpeningConflict || null,
    proposedTimelineCount: Array.isArray(body?.proposedTimeline) ? body.proposedTimeline.length : null,
    finalizedTimelineCount: Array.isArray(body?.finalizedTimeline) ? body.finalizedTimeline.length : null,
    removedHotspots: body?.removedHotspots || null,
  };
}

function compactConfirmResponse(body: any) {
  return {
    success: body?.success ?? null,
    code: body?.code || null,
    message: body?.message || null,
    attemptId: body?.attemptId || null,
    routeHotspotId: body?.routeHotspotId || null,
    inserted: body?.inserted ?? null,
    routeTimelineCount: Array.isArray(body?.routeTimeline) ? body.routeTimeline.length : null,
    finalizedTimelineCount: Array.isArray(body?.finalizedTimeline) ? body.finalizedTimeline.length : null,
  };
}

async function main() {
  const config = await parseArgs();

  if (config.showHelp) {
    printUsage();
    return;
  }

  const token = await loginAndGetToken(config.baseUrl);

  const previewPayload = {
    ...DEFAULT_PREVIEW_PAYLOAD,
    ...config.previewPayload,
    routeId: config.routeId,
    selectedHotspotId: config.selectedHotspotId,
  };

  const previewPath = `/itineraries/${config.planId}/manual-hotspot/fit-preview`;
  console.log("PREVIEW_REQUEST");
  console.log(JSON.stringify({ url: `${config.baseUrl}${previewPath}`, payload: previewPayload }, null, 2));
  console.log("INPUT_MODE");
  console.log(JSON.stringify({
    inputMode: config.inputMode,
    inputPath: config.inputPath,
  }, null, 2));

  const previewResult = await postJson(config.baseUrl, token, previewPath, previewPayload);
  console.log("PREVIEW_RESPONSE");
  console.log(JSON.stringify({
    status: previewResult.response.status,
    statusText: previewResult.response.statusText,
    body: compactPreviewResponse(previewResult.body),
  }, null, 2));

  if (!previewResult.response.ok) {
    process.exitCode = 1;
    return;
  }

  const previewAttemptId = String(previewResult.body?.attemptId || "").trim();
  if (!previewAttemptId) {
    throw new Error("Preview succeeded but no attemptId was returned.");
  }

  const confirmPayload: ConfirmPayload = {
    ...DEFAULT_CONFIRM_PAYLOAD,
    ...config.confirmPayload,
    attemptId: previewAttemptId,
  };

  const confirmPath = `/itineraries/${config.planId}/manual-hotspot/fit-confirm`;
  console.log("CONFIRM_REQUEST");
  console.log(JSON.stringify({ url: `${config.baseUrl}${confirmPath}`, payload: confirmPayload }, null, 2));

  const confirmResult = await postJson(config.baseUrl, token, confirmPath, confirmPayload);
  console.log("CONFIRM_RESPONSE");
  console.log(JSON.stringify({
    status: confirmResult.response.status,
    statusText: confirmResult.response.statusText,
    body: compactConfirmResponse(confirmResult.body),
  }, null, 2));

  if (!confirmResult.response.ok) {
    process.exitCode = 1;
    return;
  }

  console.log("PASS preview timeline replayed into main timeline successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
