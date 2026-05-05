/*
  Compare runtime mapped routes (from Nest logs) with Swagger docs-json.

  Usage:
    node scripts/check-swagger-coverage.js

  Optional env:
    BASE_URL=http://localhost:4006
    LOG_FILE=nest-output.log
*/

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4006';
const LOG_FILE = process.env.LOG_FILE || 'nest-output.log';

function normalizeRuntimePath(p) {
  // Runtime logs use :id while swagger uses {id}
  return String(p || '')
    .trim()
    .replace(/\/+/g, '/')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function normalizeSwaggerPath(p) {
  return String(p || '').trim().replace(/\/+/g, '/');
}

function keyOf(method, p) {
  return `${String(method || '').toUpperCase()} ${p}`;
}

function parseMappedRoutes(logText) {
  const lines = logText.split(/\r?\n/);
  const routes = [];

  // Example:
  // [RouterExplorer] Mapped {/api/v1/auth/login, POST} route
  const re = /Mapped \{([^,]+),\s*([A-Z]+)\} route/i;

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;

    const rawPath = m[1].trim();
    const method = m[2].toUpperCase();

    if (!rawPath.startsWith('/api/v1/')) continue;

    routes.push({
      method,
      path: normalizeRuntimePath(rawPath),
      source: line,
    });
  }

  // de-duplicate
  const seen = new Set();
  const deduped = [];
  for (const r of routes) {
    const k = keyOf(r.method, r.path);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }

  return deduped;
}

async function fetchSwaggerDoc() {
  const res = await fetch(`${BASE_URL}/api/v1/docs-json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Swagger docs-json: HTTP ${res.status}`);
  }
  return res.json();
}

function parseSwaggerRoutes(swagger) {
  const out = [];
  const paths = swagger && swagger.paths ? swagger.paths : {};

  for (const [p, methods] of Object.entries(paths)) {
    const normalizedPath = normalizeSwaggerPath(p);
    for (const method of Object.keys(methods || {})) {
      out.push({
        method: method.toUpperCase(),
        path: normalizedPath,
      });
    }
  }

  return out;
}

function printList(title, arr, max = 100) {
  console.log(`\n${title} (${arr.length})`);
  console.log('-'.repeat(80));
  for (const item of arr.slice(0, max)) {
    console.log(item);
  }
  if (arr.length > max) {
    console.log(`... and ${arr.length - max} more`);
  }
}

async function main() {
  const logPath = path.resolve(process.cwd(), LOG_FILE);
  if (!fs.existsSync(logPath)) {
    throw new Error(`Log file not found: ${logPath}`);
  }

  const logText = fs.readFileSync(logPath, 'utf8');
  const runtimeRoutes = parseMappedRoutes(logText);

  if (!runtimeRoutes.length) {
    throw new Error('No mapped /api/v1 routes found in log file. Ensure the server startup log contains RouterExplorer mapping lines.');
  }

  const swagger = await fetchSwaggerDoc();
  const swaggerRoutes = parseSwaggerRoutes(swagger);

  const swaggerSet = new Set(swaggerRoutes.map((r) => keyOf(r.method, r.path)));
  const runtimeSet = new Set(runtimeRoutes.map((r) => keyOf(r.method, r.path)));

  const missingInSwagger = runtimeRoutes
    .map((r) => keyOf(r.method, r.path))
    .filter((k) => !swaggerSet.has(k))
    .sort();

  const documentedButNotMapped = swaggerRoutes
    .map((r) => keyOf(r.method, r.path))
    .filter((k) => k.startsWith('GET /api/v1/docs') ? false : !runtimeSet.has(k))
    .sort();

  console.log('Swagger Coverage Check');
  console.log('='.repeat(80));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Log file: ${logPath}`);
  console.log(`Runtime mapped routes (/api/v1): ${runtimeRoutes.length}`);
  console.log(`Swagger routes (/api/v1 + others): ${swaggerRoutes.length}`);
  console.log(`Missing in Swagger: ${missingInSwagger.length}`);
  console.log(`Documented but not found in runtime log: ${documentedButNotMapped.length}`);

  if (missingInSwagger.length > 0) {
    printList('Missing in Swagger (method + path)', missingInSwagger, 200);
  }

  if (documentedButNotMapped.length > 0) {
    printList('In Swagger but not in runtime log (method + path)', documentedButNotMapped, 200);
  }

  process.exitCode = missingInSwagger.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Swagger coverage check failed:', err.message || err);
  process.exitCode = 1;
});
