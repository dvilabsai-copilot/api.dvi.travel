const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const eqIdx = token.indexOf('=');
    if (eqIdx > -1) {
      args[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = next;
    i += 1;
  }
  return args;
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function stripAnsi(input) {
  return input.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

async function getFileSize(filePath) {
  const stat = await fs.promises.stat(filePath);
  return stat.size;
}

async function readFileSlice(filePath, start, end) {
  if (end <= start) return '';

  const length = end - start;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function waitForLogFlush(filePath, initialSize, maxWaitMs, pollMs) {
  const started = Date.now();
  let lastSize = initialSize;
  let stableChecks = 0;

  while (Date.now() - started < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = await getFileSize(filePath);

    if (current === lastSize) {
      stableChecks += 1;
      if (stableChecks >= 2) {
        return current;
      }
      continue;
    }

    lastSize = current;
    stableChecks = 0;
  }

  return lastSize;
}

async function main() {
  const args = parseArgs(process.argv);

  const requestUrl =
    args.url ||
    process.env.ITINERARY_HOTEL_DETAILS_URL ||
    'http://127.0.0.1:4006/api/v1/itineraries/hotel_details/DVI202604247?page=1&pageSize=20';

  const token = args.token || process.env.ITINERARY_BEARER_TOKEN || '';
  const logFile =
    args.log ||
    process.env.BACKEND_LOG_FILE ||
    path.join(__dirname, '..', '..', 'backend-out.txt');

  const maxWaitMs = toNumber(args.waitMs || process.env.WAIT_MS, 8000);
  const pollMs = toNumber(args.pollMs || process.env.POLL_MS, 500);
  const method = String(args.method || process.env.REQUEST_METHOD || 'GET').toUpperCase();
  const shouldRebuildFirst = String(args.rebuildFirst || process.env.REBUILD_FIRST || 'false').toLowerCase() === 'true';

  if (!token) {
    throw new Error('Missing token. Pass --token <jwt> or set ITINERARY_BEARER_TOKEN.');
  }

  if (!fs.existsSync(logFile)) {
    throw new Error(`Log file not found: ${logFile}`);
  }

  const beforeSize = await getFileSize(logFile);

  let rebuildResponse = null;
  if (shouldRebuildFirst) {
    const rebuildUrl = requestUrl.replace('/hotel_details/', '/hotel_details/').split('?')[0] + '/rebuild';
    const rebuildRes = await fetch(rebuildUrl, {
      method: 'POST',
      headers: {
        accept: '*/*',
        authorization: `Bearer ${token}`,
      },
    });
    const rebuildText = await rebuildRes.text();
    rebuildResponse = {
      url: rebuildUrl,
      status: rebuildRes.status,
      ok: rebuildRes.ok,
      bodySnippet: rebuildText.slice(0, 400),
    };
  }

  const response = await fetch(requestUrl, {
    method,
    headers: {
      accept: '*/*',
      authorization: `Bearer ${token}`,
    },
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    responseJson = null;
  }

  const afterSize = await waitForLogFlush(logFile, beforeSize, maxWaitMs, pollMs);
  const appendedRaw = await readFileSlice(logFile, beforeSize, afterSize);
  const appendedClean = stripAnsi(appendedRaw);

  const lines = appendedClean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tboSearchLines = lines.filter((line) => line.includes('TBO Search Request (chunk:'));

  const result = {
    requestUrl,
    logFile,
    responseStatus: response.status,
    responseOk: response.ok,
    appendedLogLines: lines.length,
    totalTboSearchRequests: tboSearchLines.length,
    tboSearchRequestLines: tboSearchLines,
    responseSummary: {
      success: responseJson?.success,
      message: responseJson?.message,
    },
    rebuildResponse,
  };

  console.log(JSON.stringify(result, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`FAILED: ${error?.message || error}`);
  process.exit(1);
});
