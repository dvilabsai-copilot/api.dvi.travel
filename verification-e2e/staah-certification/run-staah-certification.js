// STAAH certification evidence runner.
// Reuses the existing STAAH adapter endpoints and payload conventions already present in this repo.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const xlsx = require('xlsx');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const OUTPUT_DIR = path.isAbsolute(process.env.STAAH_CERT_OUTPUT_DIR || '')
  ? process.env.STAAH_CERT_OUTPUT_DIR
  : path.join(ROOT_DIR, process.env.STAAH_CERT_OUTPUT_DIR || 'staah-certification-output');
const REQUESTS_DIR = path.join(OUTPUT_DIR, 'requests');
const RESPONSES_DIR = path.join(OUTPUT_DIR, 'responses');
const WORKBOOK_PATH = path.join(ROOT_DIR, 'ChannelConnectAPI_Certification_TestCase V2.xlsx');

const BASE_URL = (process.env.STAAH_CERT_BASE_URL || `http://127.0.0.1:${process.env.PORT || '4006'}`).replace(/\/+$/, '');
const API_PREFIX = (process.env.API_PREFIX || '/api/v1').replace(/\/+$/, '');
const STAAH_BASE_PATH = (process.env.STAAH_BASE_PATH || 'staah-test').replace(/^\/+|\/+$/g, '');
const FINAL_BASE_URL = `${BASE_URL}${API_PREFIX}/${STAAH_BASE_PATH}`;
const PRODUCT_INFO_URL = `${FINAL_BASE_URL}/productInfo`;
const MAPPING_URL = `${FINAL_BASE_URL}/mapping`;
const ARI_URL = `${FINAL_BASE_URL}/ari`;

const STAAH_API_KEY = process.env.STAAH_API_KEY || '';
const PROPERTY_ID = process.env.STAAH_PROPERTY_ID || 'STAAHTESTHOTEL1';
const ROOM_ID = process.env.STAAH_ROOM_ID || 'DELUXE_ROOM';
const RATEPLAN_ID = process.env.STAAH_RATEPLAN_ID || 'CP_PLAN';
const SOURCE_IP = resolveSourceIp();
const SKIP_SEED = String(process.env.STAAH_SKIP_SEED || 'false').toLowerCase() === 'true';
const SKIP_ARI_SETUP = String(process.env.STAAH_SKIP_ARI_SETUP || 'false').toLowerCase() === 'true';
const FAIL_ON_EXECUTION_FAILURE = String(process.env.STAAH_FAIL_ON_EXECUTION_FAILURE || 'false').toLowerCase() === 'true';

function resolveSourceIp() {
  if (process.env.STAAH_TEST_SOURCE_IP) {
    return process.env.STAAH_TEST_SOURCE_IP.trim();
  }

  const configured = String(process.env.STAAH_ALLOWED_IPS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return configured[0] || '127.0.0.1';
}

function ensureCleanOutput() {
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
}

function loadWorkbookSummary() {
  const workbook = xlsx.readFile(WORKBOOK_PATH);
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }),
  }));
}

function stamp() {
  return new Date().toISOString();
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value, 'utf8');
}

function sanitizeFileName(value) {
  return value.replace(/[^a-z0-9-_]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function buildHeaders() {
  const headers = {
    'content-type': 'application/json',
  };

  // Keep the IP guard intact while letting local evidence generation use a configured source IP.
  if (SOURCE_IP) {
    headers['x-forwarded-for'] = SOURCE_IP;
    headers['x-real-ip'] = SOURCE_IP;
  }

  return headers;
}

async function postJson(url, payload) {
  const requestTimestamp = stamp();
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    responseBody = responseText;
  }

  return {
    requestTimestamp,
    status: response.status,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
    rawBody: responseText,
  };
}

function workbookSource(section, rowLabel) {
  return `${section} / ${rowLabel}`;
}

function createSetupAriPayload() {
  return {
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    currency: 'INR',
    apikey: STAAH_API_KEY,
    version: '2',
    trackingId: `CERT-SETUP-${Date.now()}`,
    data: [
      {
        from_date: '2026-12-15',
        to_date: '2026-12-15',
        inventory: '9',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '5',
        minstay_through: '1',
        maxstay_through: '3',
        amountBeforeTax: {
          Rate: '4900',
          extrachild: '600.00',
          extraadult: '800.00',
          obp: { person1: '4900', person2: '5400', person3: '5700' },
        },
        amountAfterTax: {
          Rate: '4900',
          extrachild: '600',
          extraadult: '800',
          obp: { person1: '4900', person2: '5400', person3: '5700' },
        },
      },
      {
        from_date: '2026-12-15',
        to_date: '2027-01-11',
        inventory: '7',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '2',
        maxstay: '7',
        amountBeforeTax: {
          Rate: '5100',
          extrachild: '650.00',
          extraadult: '900.00',
          obp: { person1: '5100', person2: '5600', person3: '5900' },
        },
        amountAfterTax: {
          Rate: '5355',
          extrachild: '683',
          extraadult: '945',
          obp: { person1: '5355', person2: '5880', person3: '6195' },
        },
      },
      {
        from_date: '2026-06-01',
        to_date: '2026-06-10',
        inventory: '11',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '10',
        amountBeforeTax: {
          Rate: '4300',
          extrachild: '500.00',
          extraadult: '700.00',
          obp: { person1: '4300', person2: '4700', person3: '5100' },
        },
        amountAfterTax: {
          Rate: '4515',
          extrachild: '525',
          extraadult: '735',
          obp: { person1: '4515', person2: '4935', person3: '5355' },
        },
      },
      {
        from_date: '2026-01-01',
        to_date: '2026-12-31',
        inventory: '6',
        cta: 'N',
        ctd: 'N',
        stopsell: 'N',
        minstay: '1',
        maxstay: '14',
        amountBeforeTax: {
          Rate: '5200',
          extrachild: '650.00',
          extraadult: '900.00',
          obp: { person1: '5200', person2: '5700', person3: '6200' },
        },
        amountAfterTax: {
          Rate: '5460',
          extrachild: '683',
          extraadult: '945',
          obp: { person1: '5460', person2: '5985', person3: '6510' },
        },
      },
    ],
  };
}

function createExecutableCases() {
  return [
    {
      id: '01',
      name: 'Property Info',
      fileName: '01_property_info.txt',
      section: workbookSource('ARI Tests', 'Row 4 / Sr No 1'),
      excelDescription: 'Fetch Property Info (optional)',
      endpoint: PRODUCT_INFO_URL,
      method: 'POST',
      routeUsage: 'supplementary product info endpoint',
      workbookStatus: 'fully testable',
      notes: 'Optional workbook row; executed with the existing supplementary productInfo endpoint because the final single-endpoint pair covers mapping and ARI only.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        action: 'property_info',
        version: '2',
      },
    },
    {
      id: '02',
      name: 'Mapping Info',
      fileName: '02_mapping_info.txt',
      section: workbookSource('ARI Tests', 'Row 5 / Sr No 2'),
      excelDescription: 'Fetch Mapping Info (optional)',
      endpoint: MAPPING_URL,
      method: 'POST',
      routeUsage: 'single Mapping endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single mapping endpoint.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        version: '2',
      },
    },
    {
      id: '03',
      name: 'ARI Single Date',
      fileName: '03_ari_single_date.txt',
      section: workbookSource('ARI Tests', 'Row 6 / Sr No 3'),
      excelDescription: 'Fetch ARI for Single date',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-12-15',
        to_date: '2026-12-15',
        version: '2',
      },
    },
    {
      id: '04',
      name: 'ARI 28 Days',
      fileName: '04_ari_28_days.txt',
      section: workbookSource('ARI Tests', 'Row 7 / Sr No 4'),
      excelDescription: 'Fetch ARI for 28days across consecutive months',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-12-15',
        to_date: '2027-01-11',
        version: '2',
      },
    },
    {
      id: '05',
      name: 'ARI First 10 Days',
      fileName: '05_ari_first_10_days.txt',
      section: workbookSource('ARI Tests', 'Row 8 / Sr No 5'),
      excelDescription: 'Fetch ARI for first 10 days of a month',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in read mode via action ARR_info.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'ARR_info',
        from_date: '2026-06-01',
        to_date: '2026-06-10',
        version: '2',
      },
    },
    {
      id: '06',
      name: 'ARI Full Sync',
      fileName: '06_ari_year_sync.txt',
      section: workbookSource('ARI Tests', 'Row 9 / Sr No 6'),
      excelDescription: 'Fetch ARI for Full Sync (1 year or supported duration)',
      endpoint: ARI_URL,
      method: 'POST',
      routeUsage: 'single ARI endpoint',
      workbookStatus: 'fully testable',
      notes: 'Uses the final single ARI endpoint in full-sync read mode via action year_info_ARR.',
      payload: {
        apikey: STAAH_API_KEY,
        propertyid: PROPERTY_ID,
        room_id: ROOM_ID,
        rate_id: RATEPLAN_ID,
        action: 'year_info_ARR',
        version: '2',
      },
    },
  ];
}

function createBlockedBookingCases() {
  const scenarios = [
    'Create a booking for Single Room - Single Rate Plan',
    'Create a booking for Single Room - Single Rate Plan - With an Extra Adult/Child (If Supported Extras)',
    'Create a booking for a Single Room - Multiple Rate Plans - Multiple Nights',
    'Create a booking for Multiple Rooms - Multiple Rate Plans',
  ];

  const steps = [
    { label: 'Pre-Book', endpointType: 'fetch data endpoint', endpoint: 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.p' },
    { label: 'Confirm', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
    { label: 'Pre-Modify', endpointType: 'fetch data endpoint', endpoint: 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.p' },
    { label: 'Modify', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
    { label: 'Cancel', endpointType: 'booking endpoint', endpoint: 'https://channels-stage.staah.net/booking/getapi/reservation/v2' },
  ];

  const blocked = [];
  let counter = 7;
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenarioNumber = scenarioIndex + 1;
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      const id = String(counter).padStart(2, '0');
      blocked.push({
        id,
        name: `Booking Case ${scenarioNumber} ${step.label}`,
        fileName: `${id}_booking_case_${scenarioNumber}_${sanitizeFileName(step.label)}.txt`,
        section: workbookSource('Booking Tests', `Scenario ${scenarioNumber} / ${step.label}`),
        excelDescription: `${scenarios[scenarioIndex]} / ${step.label}`,
        endpoint: step.endpoint,
        method: 'POST',
        routeUsage: step.endpointType,
        workbookStatus: 'blocked',
        notes: 'Blocked: the repo does not contain a verified request contract, reusable local caller, or captured booking identifiers/session flow for the external STAAH booking-side API. Local custom reservation adapter routes are intentionally excluded from certification-safe claims.',
        blockedReason: 'Missing verified external STAAH booking/fetch request schema and identifiers in the current codebase.',
      });
      counter += 1;
    }
  }

  return blocked;
}

function toPlainText(caseResult) {
  const requestPayload = caseResult.requestPayload === undefined
    ? 'N/A'
    : JSON.stringify(caseResult.requestPayload, null, 2);
  const responseBody = caseResult.responseBody === undefined
    ? 'N/A'
    : typeof caseResult.responseBody === 'string'
      ? caseResult.responseBody
      : JSON.stringify(caseResult.responseBody, null, 2);

  return [
    `Test Case Name: ${caseResult.name}`,
    `Excel Section / Row: ${caseResult.section}`,
    `Endpoint: ${caseResult.endpoint}`,
    `Method: ${caseResult.method}`,
    `Request Time: ${caseResult.requestTime}`,
    'Request Payload / Params:',
    requestPayload,
    `Response Status: ${caseResult.responseStatus}`,
    'Response Body:',
    responseBody,
    `Pass / Fail / Blocked: ${caseResult.outcome}`,
    `Notes: ${caseResult.notes}`,
    '',
  ].join('\n');
}

function createMappingMarkdown(caseResults) {
  const header = [
    '# STAAH Certification Testcase Mapping',
    '',
    '| ID | Excel Section / Row | Test Case | Endpoint / Script | Method | Uses | Status | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const rows = caseResults.map((caseResult) => {
    const endpointOrScript = caseResult.scriptPath || caseResult.endpoint;
    return `| ${caseResult.id} | ${caseResult.section} | ${caseResult.excelDescription} | ${endpointOrScript} | ${caseResult.method} | ${caseResult.routeUsage} | ${caseResult.workbookStatus} | ${caseResult.notes.replace(/\|/g, '\\|')} |`;
  });

  return [...header, ...rows, ''].join('\n');
}

function createSummaryText(caseResults) {
  return caseResults.map((caseResult) => toPlainText(caseResult)).join('\n');
}

function createIndividualEvidence(caseResult) {
  writeText(path.join(OUTPUT_DIR, caseResult.fileName), toPlainText(caseResult));

  const requestBase = `${caseResult.id}_${sanitizeFileName(caseResult.name)}_request`;
  const responseBase = `${caseResult.id}_${sanitizeFileName(caseResult.name)}_response`;

  if (caseResult.requestPayload === undefined) {
    writeText(
      path.join(REQUESTS_DIR, `${requestBase}.txt`),
      `Endpoint: ${caseResult.endpoint}\nMethod: ${caseResult.method}\nBlocked: ${caseResult.notes}\n`,
    );
  } else {
    writeJson(path.join(REQUESTS_DIR, `${requestBase}.json`), caseResult.requestPayload);
  }

  if (caseResult.responseBody === undefined) {
    writeText(
      path.join(RESPONSES_DIR, `${responseBase}.txt`),
      `Response Status: ${caseResult.responseStatus}\nBlocked: ${caseResult.notes}\n`,
    );
  } else if (typeof caseResult.responseBody === 'string') {
    writeText(path.join(RESPONSES_DIR, `${responseBase}.txt`), caseResult.responseBody);
  } else {
    writeJson(path.join(RESPONSES_DIR, `${responseBase}.json`), caseResult.responseBody);
  }
}

function assertConfig() {
  if (!fs.existsSync(WORKBOOK_PATH)) {
    throw new Error(`Certification workbook not found: ${WORKBOOK_PATH}`);
  }

  if (!STAAH_API_KEY) {
    throw new Error('STAAH_API_KEY is required in .env to run certification evidence generation.');
  }
}

function runSeedScript() {
  if (SKIP_SEED) {
    return;
  }

  const seed = spawnSync('npm', ['run', 'seed:staah:test'], {
    cwd: ROOT_DIR,
    shell: true,
    stdio: 'inherit',
  });

  if (seed.status !== 0) {
    throw new Error('Failed to seed STAAH test data.');
  }
}

async function ensureServerReachable() {
  const response = await fetch(PRODUCT_INFO_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({}),
  }).catch((error) => {
    throw new Error(`Unable to reach local server at ${BASE_URL}: ${error.message}`);
  });

  await response.text();
}

async function runSetup() {
  if (SKIP_ARI_SETUP) {
    return;
  }

  const payload = createSetupAriPayload();
  const response = await postJson(ARI_URL, payload);

  writeJson(path.join(REQUESTS_DIR, '00_setup_ari_seed_request.json'), payload);
  writeJson(path.join(RESPONSES_DIR, '00_setup_ari_seed_response.json'), {
    status: response.status,
    body: response.body,
    requestTimestamp: response.requestTimestamp,
  });

  if (response.status !== 200 || response.body?.status !== 'success') {
    throw new Error(`ARI setup seed failed with HTTP ${response.status}.`);
  }
}

async function executeCase(caseConfig) {
  const response = await postJson(caseConfig.endpoint, caseConfig.payload);
  const outcome = response.status >= 200 && response.status < 300 && response.body && response.body.status !== 'fail'
    ? 'PASS'
    : 'FAIL';

  const workbookStatus = outcome === 'PASS' ? 'fully testable' : 'partially testable';

  return {
    ...caseConfig,
    workbookStatus,
    requestTime: response.requestTimestamp,
    requestPayload: jsonClone(caseConfig.payload),
    responseStatus: `${response.status}`,
    responseBody: response.body,
    outcome,
    notes: `${caseConfig.notes} HTTP ${response.status}.`,
  };
}

function materializeBlockedCase(caseConfig) {
  return {
    ...caseConfig,
    requestTime: stamp(),
    requestPayload: undefined,
    responseStatus: 'BLOCKED',
    responseBody: undefined,
    outcome: 'BLOCKED',
  };
}

async function main() {
  assertConfig();
  ensureCleanOutput();
  const workbook = loadWorkbookSummary();
  writeJson(path.join(OUTPUT_DIR, 'workbook-snapshot.json'), workbook);

  runSeedScript();
  await ensureServerReachable();
  await runSetup();

  const executableCases = createExecutableCases();
  const blockedCases = createBlockedBookingCases();
  const results = [];

  for (const caseConfig of executableCases) {
    const caseResult = await executeCase(caseConfig);
    results.push(caseResult);
    createIndividualEvidence(caseResult);
  }

  for (const caseConfig of blockedCases) {
    const caseResult = materializeBlockedCase(caseConfig);
    results.push(caseResult);
    createIndividualEvidence(caseResult);
  }

  writeText(path.join(OUTPUT_DIR, 'testcase-mapping.md'), createMappingMarkdown(results));
  writeText(path.join(OUTPUT_DIR, 'request-response-summary.txt'), createSummaryText(results));

  const index = {
    generatedAt: stamp(),
    baseUrl: BASE_URL,
    finalBaseUrl: FINAL_BASE_URL,
    sourceIpUsed: SOURCE_IP,
    skipSeed: SKIP_SEED,
    skipAriSetup: SKIP_ARI_SETUP,
    propertyId: PROPERTY_ID,
    roomId: ROOM_ID,
    rateplanId: RATEPLAN_ID,
    cases: results.map((result) => ({
      id: result.id,
      fileName: result.fileName,
      outcome: result.outcome,
      endpoint: result.endpoint,
      routeUsage: result.routeUsage,
    })),
  };

  writeJson(path.join(OUTPUT_DIR, 'index.json'), index);

  const failed = results.filter((result) => result.outcome === 'FAIL');
  if (failed.length > 0 && FAIL_ON_EXECUTION_FAILURE) {
    throw new Error(`Certification runner completed with ${failed.length} failed executable case(s).`);
  }

  console.log(`Generated STAAH certification evidence in ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});