import "dotenv/config";

type ConfirmPayload = {
  attemptId: string;
  allowTimingRisk?: boolean;
  allowClosedHotspotConflict?: boolean;
  allowPriorityRemoval?: boolean;
  acknowledgedRemovedHotspotIds?: number[];
};

const DEFAULT_URL = process.env.FIT_CONFIRM_URL || "";
const DEFAULT_TOKEN = process.env.FIT_CONFIRM_TOKEN || process.env.FIT_TOKEN || "";
const DEFAULT_PAYLOAD_TEXT =
  process.env.FIT_CONFIRM_PAYLOAD
  || process.env.FIT_CONFIRM_BODY
  || "";

function printUsageAndExit(message: string): never {
  console.error(message);
  console.error("");
  console.error("Example:");
  console.error(
    "FIT_CONFIRM_URL='http://127.0.0.1:4006/api/v1/itineraries/9706/manual-hotspot/fit-confirm' " +
    "FIT_CONFIRM_TOKEN='<bearer-token>' " +
    "FIT_CONFIRM_PAYLOAD='{\"attemptId\":\"...\",\"allowTimingRisk\":false,\"allowClosedHotspotConflict\":false,\"allowPriorityRemoval\":false,\"acknowledgedRemovedHotspotIds\":[]}' " +
    "npm run debug:fit-confirm",
  );
  process.exit(1);
}

function parsePayload(raw: string): ConfirmPayload {
  if (!raw.trim()) {
    printUsageAndExit("Missing FIT_CONFIRM_PAYLOAD env var.");
  }

  try {
    return JSON.parse(raw) as ConfirmPayload;
  } catch (error: any) {
    printUsageAndExit(`FIT_CONFIRM_PAYLOAD is not valid JSON: ${error?.message || error}`);
  }
}

function summarizeAttempts(plan: any): any[] {
  const attempts = Array.isArray(plan?.simulationAttempts) ? plan.simulationAttempts : [];
  return attempts.map((attempt: any) => ({
    attemptNumber: Number(attempt?.attemptNumber || 0),
    removedHotspotIds: Array.isArray(attempt?.removedHotspotIds) ? attempt.removedHotspotIds.map(Number) : [],
    removedHotspotNames: Array.isArray(attempt?.removedHotspotNames) ? attempt.removedHotspotNames : [],
    finalOverflowMinutes: Number(attempt?.finalOverflowMinutes || attempt?.dayEndOverflowMinutes || 0),
    finalArrivalTime: attempt?.finalArrivalTime || null,
    resolved: attempt?.resolved === true,
    valid: attempt?.valid === true,
    displayTimelineErrors: Array.isArray(attempt?.displayTimelineErrors) ? attempt.displayTimelineErrors : [],
  }));
}

function summarizeCandidates(plan: any): any[] {
  const candidates = Array.isArray(plan?.candidates) ? plan.candidates : [];
  return candidates.map((candidate: any) => ({
    hotspotId: Number(candidate?.id || candidate?.hotspotId || candidate?.row?.hotspot_ID || 0),
    name: String(candidate?.name || candidate?.row?.text || candidate?.row?.hotspot_name || "").trim(),
    priority: Number(candidate?.priority || 0) || null,
    routeId: Number(candidate?.row?.itinerary_route_ID || 0) || null,
    timelineIndex: Number(candidate?.timelineIndex || 0),
    endMinutes: Number(candidate?.endMinutes || 0) || null,
  }));
}

function describeFailure(status: number, body: any) {
  console.log("");
  console.log("Diagnostic summary:");

  if (status !== 409) {
    console.log(`- HTTP status: ${status}`);
    return;
  }

  const code = String(body?.code || "").trim();
  const message = String(body?.message || "").trim();
  console.log(`- Code: ${code || "n/a"}`);
  console.log(`- Message: ${message || "n/a"}`);

  if (code === "MANUAL_INSERT_EXCEEDS_DAY_END_NO_LOW_PRIORITY_REMOVAL_AVAILABLE") {
    const plan = body?.lowPriorityRemovalPlan || {};
    console.log(
      `- Meaning: confirm replay still overflows route end after trying same-route removals.`,
    );
    console.log(
      `- Final overflow: ${Number(plan?.finalOverflowMinutes || body?.overflowMinutes || 0)} minute(s).`,
    );
    console.log(
      `- Final arrival: ${String(plan?.finalArrivalTime || "n/a")}.`,
    );
    console.log("- Removal candidates:");
    console.log(JSON.stringify(summarizeCandidates(plan), null, 2));
    console.log("- Simulation attempts:");
    console.log(JSON.stringify(summarizeAttempts(plan), null, 2));
  }
}

async function main() {
  if (!DEFAULT_URL.trim()) {
    printUsageAndExit("Missing FIT_CONFIRM_URL env var.");
  }
  if (!DEFAULT_TOKEN.trim()) {
    printUsageAndExit("Missing FIT_CONFIRM_TOKEN or FIT_TOKEN env var.");
  }

  const payload = parsePayload(DEFAULT_PAYLOAD_TEXT);

  console.log("Request:");
  console.log(JSON.stringify({
    url: DEFAULT_URL,
    payload,
  }, null, 2));

  const response = await fetch(DEFAULT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEFAULT_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody: any = responseText;

  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = responseText;
  }

  console.log("");
  console.log("Response:");
  console.log(JSON.stringify({
    status: response.status,
    statusText: response.statusText,
    body: responseBody,
  }, null, 2));

  describeFailure(response.status, responseBody);

  if (!response.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
