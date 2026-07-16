import * as fs from 'node:fs';
import * as path from 'node:path';

type OpenApiDocument = {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

function readDocument(file: string): OpenApiDocument {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as OpenApiDocument;
}

function contractOf(operation: unknown): unknown {
  if (!operation || typeof operation !== 'object') return operation;
  const source = operation as Record<string, unknown>;
  return {
    parameters: source.parameters,
    requestBody: source.requestBody,
    responses: source.responses,
    security: source.security,
  };
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function routeContracts(document: OpenApiDocument): Map<string, string> {
  const result = new Map<string, string>();
  for (const [route, operations] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(operations || {})) {
      if (methods.has(method)) result.set(`${method.toUpperCase()} ${route}`, stable(contractOf(operation)));
    }
  }
  return result;
}

function duplicateOperationIds(document: OpenApiDocument): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const [route, operations] of Object.entries(document.paths || {})) {
    for (const [method, operation] of Object.entries(operations || {})) {
      if (!methods.has(method)) continue;
      const id = (operation as { operationId?: string })?.operationId;
      if (!id) continue;
      const current = `${method.toUpperCase()} ${route}`;
      if (seen.has(id)) duplicates.push(`${id}: ${seen.get(id)} and ${current}`);
      else seen.set(id, current);
    }
  }
  return duplicates;
}

function collectRefs(value: unknown, refs: Set<string>) {
  if (Array.isArray(value)) return value.forEach((item) => collectRefs(item, refs));
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string') refs.add(item);
    else collectRefs(item, refs);
  }
}

function main() {
  const baselineFile = process.argv[2] || 'docs/testing/openapi-baseline.json';
  const currentFile = process.argv[3] || baselineFile;
  const baseline = readDocument(baselineFile);
  const current = readDocument(currentFile);
  const baselineRoutes = routeContracts(baseline);
  const currentRoutes = routeContracts(current);
  const missing = [...baselineRoutes.keys()].filter((key) => !currentRoutes.has(key)).sort();
  const added = [...currentRoutes.keys()].filter((key) => !baselineRoutes.has(key)).sort();
  const changed = [...baselineRoutes.keys()].filter((key) => currentRoutes.has(key) && baselineRoutes.get(key) !== currentRoutes.get(key)).sort();
  const duplicateIds = duplicateOperationIds(current);
  const refs = new Set<string>();
  collectRefs(current, refs);
  const schemas = new Set(Object.keys(current.components?.schemas || {}).map((name) => `#/components/schemas/${name}`));
  const brokenRefs = [...refs].filter((ref) => ref.startsWith('#/components/schemas/') && !schemas.has(ref)).sort();

  console.log(`Baseline routes: ${baselineRoutes.size}`);
  console.log(`Current routes: ${currentRoutes.size}`);
  console.log(`Missing routes: ${missing.length}`);
  console.log(`Added routes: ${added.length}`);
  console.log(`Changed contracts: ${changed.length}`);
  console.log(`Duplicate operation IDs: ${duplicateIds.length}`);
  console.log(`Broken schema references: ${brokenRefs.length}`);
  for (const [label, values] of [['Missing', missing], ['Added', added], ['Changed', changed], ['Duplicate operation IDs', duplicateIds], ['Broken schema references', brokenRefs]] as const) {
    if (values.length) {
      console.log(`\n${label}:`);
      values.forEach((value) => console.log(`- ${value}`));
    }
  }
  process.exitCode = missing.length || changed.length || duplicateIds.length || brokenRefs.length ? 1 : 0;
}

main();
