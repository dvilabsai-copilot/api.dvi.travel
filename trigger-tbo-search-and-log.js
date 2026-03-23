const fs = require('fs');
const path = require('path');
const axios = require('axios');

function extractLastJsonAfterMarker(text, marker) {
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return null;

  const start = text.indexOf('{', idx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

async function main() {
  const apiBase = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
  const endpoint = `${apiBase}/hotels/search`;

  const payload = {
    cityCode: '130990',
    checkInDate: '2026-04-27',
    checkOutDate: '2026-05-01',
    roomCount: 1,
    guestCount: 2,
    adultCount: 2,
    childCount: 0,
    guestNationality: 'IN',
    occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
    providers: ['tbo'],
  };

  console.log('[trigger] Calling backend search endpoint...');
  const apiResp = await axios.post(endpoint, payload, {
    timeout: 120000,
    headers: { 'Content-Type': 'application/json' },
  });
  console.log(`[trigger] Backend response status: ${apiResp.status}`);

  // Wait briefly to ensure logs are flushed
  await new Promise((r) => setTimeout(r, 1500));

  const logFile = process.env.LOG_FILE || 'server-logs-live.txt';
  const logPath = path.join(process.cwd(), logFile);
  if (!fs.existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  let logText = fs.readFileSync(logPath, 'utf8');
  if (!logText.includes('TBO Search Request JSON:') && !logText.includes('TBO API Response JSON:')) {
    // PowerShell Tee-Object commonly writes UTF-16LE text on Windows.
    logText = fs.readFileSync(logPath, 'utf16le');
  }

  const lastReq = extractLastJsonAfterMarker(logText, 'TBO Search Request JSON:');
  const lastRes = extractLastJsonAfterMarker(logText, 'TBO API Response JSON:');

  const fallbackCodes = [...logText.matchAll(/- Hotel Codes:\s*([^\n\r]+)/g)];
  const fallbackStatus = [...logText.matchAll(/TBO Search returned status:\s*([^\n\r]+)/g)];

  const outPath = path.join(process.cwd(), 'tbo-postman-from-code-latest.txt');

  const lines = [];
  lines.push('TBO REQUEST/RESPONSE (FROM BACKEND CODE PATH)');
  lines.push('=============================================');
  lines.push('');
  lines.push('Trigger: POST /api/v1/hotels/search');
  lines.push(`Trigger endpoint: ${endpoint}`);
  lines.push(`Trigger status: ${apiResp.status}`);
  lines.push('');
  lines.push('Outbound TBO request (Postman style):');
  lines.push('Method: POST');
  lines.push('URL: https://affiliate.tektravels.com/HotelAPI/Search');
  lines.push('Headers:');
  lines.push('  Content-Type: application/json');
  lines.push('  Authorization: Basic VEJPQXBpOlRCT0FwaUAxMjM=');
  lines.push('');
  lines.push('Body:');
  if (lastReq) {
    try {
      lines.push(JSON.stringify(JSON.parse(lastReq), null, 2));
    } catch {
      lines.push(lastReq);
    }
  } else {
    lines.push('{');
    lines.push('  "note": "Full request JSON log not found; enable/keep TBO_LOG_FULL_PAYLOAD=true and retry."');
    if (fallbackCodes.length) {
      const csv = fallbackCodes[fallbackCodes.length - 1][1].trim();
      lines.push(`  "hotelCodesFromLog": "${csv}"`);
    }
    lines.push('}');
  }

  lines.push('');
  lines.push('Response (raw from TBO in provider log):');
  if (lastRes) {
    try {
      lines.push(JSON.stringify(JSON.parse(lastRes), null, 2));
    } catch {
      lines.push(lastRes);
    }
  } else {
    lines.push('{');
    lines.push('  "note": "Full response JSON log not found."');
    if (fallbackStatus.length) {
      const st = fallbackStatus[fallbackStatus.length - 1][1].trim();
      lines.push(`  "statusFromLog": "${st}"`);
    }
    lines.push('}');
  }

  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`[trigger] Saved: ${outPath}`);
}

main().catch((err) => {
  console.error('[trigger] FAILED:', err.message);
  process.exit(1);
});
