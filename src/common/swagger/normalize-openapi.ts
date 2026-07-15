const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

function operationSuffix(route: string, method: string): string {
  const pathPart = route
    .replace(/^\/+/, '')
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${pathPart || 'root'}`;
}

/**
 * Swagger accepts a controller with multiple route prefixes, but that can
 * emit duplicate operationIds. Keep the first documented id for compatibility
 * and make subsequent aliases unique and deterministic.
 */
export function ensureUniqueOpenApiOperationIds(document: any): any {
  const used = new Set<string>();

  for (const [route, operations] of Object.entries(document?.paths || {})) {
    for (const [method, operation] of Object.entries(operations as Record<string, any>)) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;

      const base = String(operation.operationId || `${method}_${route}`);
      let candidate = base;
      if (used.has(candidate)) {
        candidate = `${base}_${operationSuffix(route, method)}`;
        let counter = 2;
        while (used.has(candidate)) {
          candidate = `${base}_${operationSuffix(route, method)}_${counter++}`;
        }
      }

      operation.operationId = candidate;
      used.add(candidate);
    }
  }

  return document;
}
