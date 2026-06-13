type StoredLocationLookupContext = {
  planId?: number | null;
  routeId?: number | string | bigint | null;
  source?: string | null;
  destination?: string | null;
};

type StoredLocationPairLookupOptions<T> = StoredLocationLookupContext & {
  lookup: () => Promise<T | null>;
  serialize?: (value: T | null) => unknown;
};

const storedLocationPairCache = new Map<string, unknown>();

function shouldDebugStoredLocationCache(): boolean {
  return String(process.env.DEBUG_STORED_LOCATION_CACHE || '').toLowerCase() === 'true';
}

function normalizeStoredLocationText(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildStoredLocationCacheKey(
  source: string | null | undefined,
  destination: string | null | undefined,
): string {
  return `${normalizeStoredLocationText(source)}::${normalizeStoredLocationText(destination)}`;
}

function buildStoredLocationLogPayload(context: StoredLocationLookupContext) {
  return {
    planId: context.planId ?? null,
    routeId: context.routeId ?? null,
    source: String(context.source || ''),
    destination: String(context.destination || ''),
  };
}

export function clearStoredLocationCache(reason: string): void {
  const clearedEntries = storedLocationPairCache.size;
  storedLocationPairCache.clear();
  console.log('[DVI_STORED_LOCATION_CACHE_CLEAR]', {
    reason,
    clearedEntries,
    cacheSizeAfterClear: storedLocationPairCache.size,
  });
}

export async function getCachedStoredLocationPair<T>(
  options: StoredLocationPairLookupOptions<T>,
): Promise<T | null> {
  const {
    source,
    destination,
    lookup,
    serialize,
    planId = null,
    routeId = null,
  } = options;

  const forwardKey = buildStoredLocationCacheKey(source, destination);
  const reverseKey = buildStoredLocationCacheKey(destination, source);
  const logContext = buildStoredLocationLogPayload({ planId, routeId, source, destination });

  if (storedLocationPairCache.has(forwardKey)) {
    if (shouldDebugStoredLocationCache()) {
      console.log('[DVI_STORED_LOCATION_CACHE_HIT]', {
        ...logContext,
        cacheKey: forwardKey,
        cacheDirection: 'forward',
      });
    }
    return (storedLocationPairCache.get(forwardKey) as T | null) ?? null;
  }

  if (storedLocationPairCache.has(reverseKey)) {
    if (shouldDebugStoredLocationCache()) {
      console.log('[DVI_STORED_LOCATION_CACHE_HIT]', {
        ...logContext,
        cacheKey: reverseKey,
        cacheDirection: 'reverse',
      });
    }
    return (storedLocationPairCache.get(reverseKey) as T | null) ?? null;
  }

  if (shouldDebugStoredLocationCache()) {
    console.log('[DVI_STORED_LOCATION_CACHE_MISS]', {
      ...logContext,
      cacheKey: forwardKey,
    });
  }

  const lookupStartedAt = Date.now();
  const value = await lookup();
  const dbLookupDurationMs = Date.now() - lookupStartedAt;

  if (shouldDebugStoredLocationCache()) {
    console.log('[DVI_STORED_LOCATION_DB_LOOKUP]', {
      ...logContext,
      cacheKey: forwardKey,
      dbLookupDurationMs,
      found: value !== null,
    });
  }

  storedLocationPairCache.set(forwardKey, value);
  storedLocationPairCache.set(reverseKey, value);

  if (shouldDebugStoredLocationCache()) {
    console.log('[DVI_STORED_LOCATION_CACHE_STORE]', {
      ...logContext,
      cacheKey: forwardKey,
      cacheKeysStored: forwardKey === reverseKey ? 1 : 2,
      storedNull: value === null,
      cachedValue: serialize ? serialize(value) : value !== null,
    });
  }

  return value;
}
