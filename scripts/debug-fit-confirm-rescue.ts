import "dotenv/config";

type ConfirmPayload = {
  attemptId: string;
  allowTimingRisk?: boolean;
  allowClosedHotspotConflict?: boolean;
  allowPriorityRemoval?: boolean;
  acknowledgedRemovedHotspotIds?: number[];
};

type HttpResult = {
  status: number;
  statusText: string;
  body: any;
  rawText: string;
};

const DEFAULT_URL = process.env.FIT_CONFIRM_URL || "";
const DEFAULT_TOKEN = process.env.FIT_CONFIRM_TOKEN || process.env.FIT_TOKEN || "";
const DEFAULT_PAYLOAD_TEXT =
  process.env.FIT_CONFIRM_PAYLOAD ||
  process.env.FIT_CONFIRM_BODY ||
  "";
const AUTO_RETRY = String(process.env.FIT_CONFIRM_AUTO_RETRY || "true").trim().toLowerCase() !== "false";

function printUsageAndExit(message: string): never {
  console.error(message);
  console.error("");
  console.error("Example:");
  console.error(
    "FIT_CONFIRM_URL='http://127.0.0.1:4006/api/v1/itineraries/9825/manual-hotspot/fit-confirm' " +
    "FIT_CONFIRM_TOKEN='<bearer-token>' " +
    "FIT_CONFIRM_PAYLOAD='{\"attemptId\":\"c7cdf1f5-2e3b-41ce-be45-b5c98eef9543\",\"allowTimingRisk\":false,\"allowClosedHotspotConflict\":false,\"allowPriorityRemoval\":true,\"acknowledgedRemovedHotspotIds\":[257]}' " +
    "npm run debug:fit-confirm:rescue",
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

function asPositiveNumber(value: any): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function collectPositiveIds(value: any): number[] {
  if (!Array.isArray(value)) return [];

  const ids = value
    .map((row: any) => {
      if (typeof row === "number" || typeof row === "string" || typeof row === "bigint") {
        return asPositiveNumber(row);
      }

      return asPositiveNumber(
        row?.id ||
        row?.hotspotId ||
        row?.hotspot_ID ||
        row?.hotspot_id ||
        row?.locationId ||
        row?.hotspotId ||
        row?.row?.hotspot_ID ||
        row?.row?.hotspotId ||
        0,
      );
    })
    .filter((id: number | null): id is number => id !== null);

  return Array.from(new Set(ids));
}

function pickFirstNonEmptyIdList(...lists: number[][]): number[] {
  for (const list of lists) {
    if (Array.isArray(list) && list.length > 0) {
      return Array.from(new Set(list.map((id) => Number(id)).filter((id) => id > 0)));
    }
  }

  return [];
}

function parseResponseBody(rawText: string): any {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return "";

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function postConfirm(url: string, token: string, payload: ConfirmPayload): Promise<HttpResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  return {
    status: response.status,
    statusText: response.statusText,
    body: parseResponseBody(rawText),
    rawText,
  };
}

function buildRetryPayload(original: ConfirmPayload, failureBody: any): ConfirmPayload | null {
  const code = String(failureBody?.code || "").trim();
  const retryPayload: ConfirmPayload = {
    ...original,
    allowPriorityRemoval: original.allowPriorityRemoval === true,
    allowTimingRisk: original.allowTimingRisk === true,
    allowClosedHotspotConflict: original.allowClosedHotspotConflict === true,
    acknowledgedRemovedHotspotIds: Array.isArray(original.acknowledgedRemovedHotspotIds)
      ? Array.from(new Set(original.acknowledgedRemovedHotspotIds.map((id) => Number(id)).filter((id) => id > 0)))
      : [],
  };

  if (code === "MANUAL_INSERT_SELECTED_HOTSPOT_CLOSING_NOT_RESOLVED") {
    retryPayload.allowTimingRisk = true;
    retryPayload.allowClosedHotspotConflict = true;
    retryPayload.allowPriorityRemoval = true;
    return retryPayload;
  }

  if (code === "MANUAL_INSERT_REMOVAL_ACKNOWLEDGEMENT_REQUIRED") {
    retryPayload.allowPriorityRemoval = true;

    const plannedRemovalIds = pickFirstNonEmptyIdList(
      collectPositiveIds(failureBody?.plannedRemovalIds),
      collectPositiveIds(failureBody?.openingHoursRemovalPlan?.removedHotspots),
      collectPositiveIds(failureBody?.requiredRemovedHotspotIds),
    );

    if (plannedRemovalIds.length > 0) {
      retryPayload.acknowledgedRemovedHotspotIds = plannedRemovalIds;
    }

    return retryPayload;
  }

  return null;
}

function printResult(label: string, result: HttpResult): void {
  console.log("");
  console.log(`[${label}]`);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        statusText: result.statusText,
        body: result.body,
      },
      null,
      2,
    ),
  );
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
  console.log(
    JSON.stringify(
      {
        url: DEFAULT_URL,
        payload,
        autoRetry: AUTO_RETRY,
      },
      null,
      2,
    ),
  );

  const firstResult = await postConfirm(DEFAULT_URL, DEFAULT_TOKEN, payload);
  printResult("FIRST_RESPONSE", firstResult);

  if (firstResult.status === 409 && AUTO_RETRY) {
    const retryPayload = buildRetryPayload(payload, firstResult.body);
    if (retryPayload) {
      console.log("");
      console.log(
        JSON.stringify(
          {
            action: "retrying_with_rescue_payload",
            code: String(firstResult.body?.code || ""),
            retryPayload,
          },
          null,
          2,
        ),
      );

      const retryResult = await postConfirm(DEFAULT_URL, DEFAULT_TOKEN, retryPayload);
      printResult("RETRY_RESPONSE", retryResult);

      if (retryResult.status >= 200 && retryResult.status < 300) {
        console.log("");
        console.log("Recovered successfully with the force-conflict confirmation payload.");
        return;
      }

      process.exit(1);
    }
  }

  if (firstResult.status >= 200 && firstResult.status < 300) {
    console.log("");
    console.log("Confirmed successfully.");
    return;
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
