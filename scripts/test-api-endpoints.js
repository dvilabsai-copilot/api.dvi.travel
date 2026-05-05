/*
  Reusable API smoke test for DVI backend.

  Usage:
    node scripts/test-api-endpoints.js

  Optional env overrides:
    BASE_URL=http://localhost:4006
    LOGIN_EMAIL=admin@dvi.co.in
    LOGIN_PASSWORD=Keerthi@2404ias
    REQUEST_TIMEOUT_MS=15000
    RUN_FULL_SWEEP=true
    SWEEP_MAX_ENDPOINTS=300
*/

const BASE_URL = process.env.BASE_URL || 'http://localhost:4006';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const RUN_FULL_SWEEP = String(process.env.RUN_FULL_SWEEP || 'false').toLowerCase() === 'true';
const SWEEP_MAX_ENDPOINTS = Number(process.env.SWEEP_MAX_ENDPOINTS || 300);

function nowMs() {
  return Date.now();
}

function prettyMs(ms) {
  return `${ms}ms`;
}

async function httpRequest({ method, path, headers = {}, body }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = `${BASE_URL}${path}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON response is acceptable for some endpoints like Swagger HTML.
    }

    return {
      ok: true,
      status: response.status,
      text,
      json,
      url,
    };
  } catch (error) {
    return {
      ok: false,
      error,
      url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function result(pass, name, details, durationMs) {
  return {
    pass,
    name,
    details,
    durationMs,
  };
}

async function getSwaggerDocument() {
  const res = await httpRequest({ method: 'GET', path: '/api/v1/docs-json' });
  if (!res.ok || res.status !== 200 || !res.json) {
    return null;
  }
  return res.json;
}

function isStaticGetPath(path, methodsObj) {
  if (!methodsObj || !methodsObj.get) {
    return false;
  }
  if (path.includes('{') || path.includes('}')) {
    return false;
  }
  return true;
}

function getStaticGetPathsFromSwagger(swaggerDoc) {
  if (!swaggerDoc || !swaggerDoc.paths || typeof swaggerDoc.paths !== 'object') {
    return [];
  }

  const list = [];
  for (const [path, methodsObj] of Object.entries(swaggerDoc.paths)) {
    if (!isStaticGetPath(path, methodsObj)) {
      continue;
    }
    list.push(path);
  }

  return list
    .filter((p) => p !== '/api/v1/docs' && p !== '/api/v1/docs-json')
    .sort();
}

function statusLooksHealthy(status) {
  // For broad sweeps we accept functional statuses and auth/validation denials,
  // and treat only server faults as failures.
  return status < 500;
}

async function sweepRemainingStaticGetEndpoints(token) {
  const start = nowMs();
  const swaggerDoc = await getSwaggerDocument();

  if (!swaggerDoc) {
    return [
      result(false, 'Full sweep (remaining GET endpoints)', 'Could not load /api/v1/docs-json', nowMs() - start),
    ];
  }

  const paths = getStaticGetPathsFromSwagger(swaggerDoc).slice(0, SWEEP_MAX_ENDPOINTS);
  const rows = [];

  for (const path of paths) {
    const noAuthStart = nowMs();
    const noAuth = await httpRequest({ method: 'GET', path });
    const noAuthMs = nowMs() - noAuthStart;

    let auth = null;
    let authMs = 0;
    if (token) {
      const authStart = nowMs();
      auth = await httpRequest({
        method: 'GET',
        path,
        headers: { Authorization: `Bearer ${token}` },
      });
      authMs = nowMs() - authStart;
    }

    const noAuthPass = noAuth.ok && statusLooksHealthy(noAuth.status);
    const authPass = !token ? true : auth && auth.ok && statusLooksHealthy(auth.status);
    const pass = noAuthPass && authPass;

    const details = `GET ${path} -> noAuth=${noAuth.ok ? noAuth.status : 'ERR'} (${noAuthMs}ms)` +
      (token ? `, auth=${auth && auth.ok ? auth.status : 'ERR'} (${authMs}ms)` : '');

    rows.push(result(pass, `Sweep: ${path}`, details, noAuthMs + authMs));
  }

  const summaryStart = nowMs();
  const failed = rows.filter((r) => !r.pass).length;
  const summary = result(
    failed === 0,
    'Full sweep (remaining GET endpoints)',
    `Checked ${rows.length} static GET endpoint(s) from Swagger. Failures: ${failed}.`,
    nowMs() - summaryStart,
  );

  return [summary, ...rows];
}

async function testSwaggerDocs() {
  const start = nowMs();
  const res = await httpRequest({ method: 'GET', path: '/api/v1/docs' });

  if (!res.ok) {
    return result(false, 'Swagger docs', `Request failed: ${String(res.error)}`, nowMs() - start);
  }

  const pass = res.status === 200;
  return result(
    pass,
    'Swagger docs',
    pass ? 'GET /api/v1/docs returned 200' : `Expected 200, got ${res.status}`,
    nowMs() - start,
  );
}

async function testLogin() {
  const start = nowMs();
  const res = await httpRequest({
    method: 'POST',
    path: '/api/v1/auth/login',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: LOGIN_EMAIL,
      password: LOGIN_PASSWORD,
    }),
  });

  if (!res.ok) {
    return {
      test: result(false, 'Auth login', `Request failed: ${String(res.error)}`, nowMs() - start),
      token: null,
    };
  }

  const statusOk = res.status === 200 || res.status === 201;
  const token =
    (res.json && (res.json.accessToken || res.json.token)) ||
    (res.json && res.json.data && (res.json.data.accessToken || res.json.data.token)) ||
    null;

  const pass = statusOk && typeof token === 'string' && token.length > 0;
  const details = pass
    ? `POST /api/v1/auth/login returned ${res.status} and token captured`
    : `Expected 200/201 + token, got status=${res.status}, tokenPresent=${Boolean(token)}`;

  return {
    test: result(pass, 'Auth login', details, nowMs() - start),
    token,
  };
}

async function testDashboardWithToken(token) {
  const start = nowMs();
  const res = await httpRequest({
    method: 'GET',
    path: '/api/v1/dashboard/stats',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    return result(false, 'v1 dashboard (auth)', `Request failed: ${String(res.error)}`, nowMs() - start);
  }

  const pass = res.status === 200;
  return result(
    pass,
    'v1 dashboard (auth)',
    pass ? 'GET /api/v1/dashboard/stats returned 200' : `Expected 200, got ${res.status}`,
    nowMs() - start,
  );
}

async function testGraphqlUnauthorized() {
  const start = nowMs();
  const res = await httpRequest({
    method: 'POST',
    path: '/api/v2/graphql',
    headers: {
      'Content-Type': 'application/json',
      'apollo-require-preflight': 'true',
    },
    body: JSON.stringify({
      query: 'query { dashboardSummaryV2 { stats { totalAgents } } }',
    }),
  });

  if (!res.ok) {
    return result(false, 'GraphQL unauthorized check', `Request failed: ${String(res.error)}`, nowMs() - start);
  }

  const hasErrors = Boolean(res.json && Array.isArray(res.json.errors) && res.json.errors.length > 0);
  const pass = res.status === 200 && hasErrors;

  return result(
    pass,
    'GraphQL unauthorized check',
    pass
      ? 'POST /api/v2/graphql without token returned GraphQL errors as expected'
      : `Expected status=200 with errors, got status=${res.status}, hasErrors=${hasErrors}`,
    nowMs() - start,
  );
}

async function testGraphqlWithToken(token) {
  const start = nowMs();
  const res = await httpRequest({
    method: 'POST',
    path: '/api/v2/graphql',
    headers: {
      'Content-Type': 'application/json',
      'apollo-require-preflight': 'true',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query:
        'query { dashboardSummaryV2 { stats { totalAgents totalDrivers totalItineraries confirmedBookings totalRevenue } } }',
    }),
  });

  if (!res.ok) {
    return result(false, 'GraphQL dashboardSummaryV2 (auth)', `Request failed: ${String(res.error)}`, nowMs() - start);
  }

  const hasErrors = Boolean(res.json && Array.isArray(res.json.errors) && res.json.errors.length > 0);
  const hasData = Boolean(
    res.json &&
      res.json.data &&
      res.json.data.dashboardSummaryV2 &&
      res.json.data.dashboardSummaryV2.stats,
  );

  const pass = res.status === 200 && !hasErrors && hasData;

  return result(
    pass,
    'GraphQL dashboardSummaryV2 (auth)',
    pass
      ? 'POST /api/v2/graphql with token returned dashboardSummaryV2 data'
      : `Expected status=200, no errors, data present; got status=${res.status}, hasErrors=${hasErrors}, hasData=${hasData}`,
    nowMs() - start,
  );
}

function printSummary(results) {
  console.log('\nAPI Smoke Test Summary');
  console.log('='.repeat(80));

  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.name} (${prettyMs(r.durationMs)})`);
    console.log(`  ${r.details}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('-'.repeat(80));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
}

async function main() {
  const results = [];

  results.push(await testSwaggerDocs());

  const login = await testLogin();
  results.push(login.test);

  if (login.token) {
    results.push(await testDashboardWithToken(login.token));
  } else {
    results.push(result(false, 'v1 dashboard (auth)', 'Skipped: no token from login', 0));
  }

  results.push(await testGraphqlUnauthorized());

  if (login.token) {
    results.push(await testGraphqlWithToken(login.token));
  } else {
    results.push(result(false, 'GraphQL dashboardSummaryV2 (auth)', 'Skipped: no token from login', 0));
  }

  if (RUN_FULL_SWEEP) {
    const sweepResults = await sweepRemainingStaticGetEndpoints(login.token);
    results.push(...sweepResults);
  }

  printSummary(results);

  const failed = results.some((r) => !r.pass);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error('Unexpected failure while running API smoke tests:', error);
  process.exitCode = 1;
});
