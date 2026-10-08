export interface CityComparisonInput {
  cityIdA?: number | null;
  cityIdB?: number | null;
  cityNameA?: string | null;
  cityNameB?: string | null;
}

export type CachedCityRecord = {
  id: number;
  name: string;
  state_id: number | null;
  tbo_city_code: string | null;
  hobse_city_code: string | null;
};

const LOCATION_SUFFIX_PATTERNS: RegExp[] = [
  /\b(international|domestic)\b/g,
  /\bair\s*port\b/g,
  /\bairport\b/g,
  /\brailway\b/g,
  /\brail\b/g,
  /\bstation\b/g,
  /\bstn\b/g,
  /\bjunction\b/g,
  /\bjn\b/g,
  /\bterminal\b/g,
  /\bbus\s*stand\b/g,
  /\bstand\b/g,
  /\bterminus\b/g,
  /\bcentral\b/g,
  /\bchatram\b/g,
  /\bksr\b/g,
  /\bksrtc\b/g,
  /\bdomestic\b/g,
];

const LOCATION_ALIAS_MAP: Record<string, string> = {
  bangaloreinternationalairport: 'bengaluru',
  bangaloreksrrailwaystation: 'bengaluru',
  chennaidomesticairport: 'chennai',
  chennaiinternationalairport: 'chennai',
  chennaiegmorestation: 'chennai',
  chennaicentral: 'chennai',
  cochininternationalairport: 'cochin',
  coimbatoreinternationalairport: 'coimbatore',
  coimbatorerailwaystation: 'coimbatore',
  trivandrumdomesticairport: 'thiruvananthapuram',
  trivandrumcentralrailwaystation: 'thiruvananthapuram',
  trivandrumrailwaystation: 'thiruvananthapuram',
  pondicherryairport: 'puducherry',
  trichyairporttrz: 'tiruchirappalli',
  trichyjunction: 'tiruchirappalli',
  trichychatrambusstand: 'tiruchirappalli',
  calicutrailwaystation: 'kozhikode',
  calicutinternationalairport: 'karipur',
  maduraiairport: 'madurai',
  madurairailwaystation: 'madurai',
  mangaloreinternationalairport: 'mangaluru',
  mangalorerailwaystation: 'mangaluru',
  hubliksrtcbusstand: 'hubballi',
  hubliairportgandhinagar: 'hubballi',
  hublibusstandrajendranagar: 'hubballi',
  tirupatirailwaystation: 'tirupati',
  tirupatiairport: 'tirupati',
  tirupatibusstop: 'tirupati',
  reniguntarailwaystation: 'tirupati',
  visakhapatnamairport: 'visakhapatnam',
  visakhapatnambusstand: 'visakhapatnam',
  hyderabadrajivgandhiinternationalairport: 'hyderabad',
};

const CITY_ALIAS_MAP: Record<string, string> = {
  trivandrum: 'thiruvananthapuram',
  trivandrumcity: 'thiruvananthapuram',
  tvm: 'thiruvananthapuram',
  bangalore: 'bengaluru',
  bengalore: 'bengaluru',
  mangalore: 'mangaluru',
  mysore: 'mysuru',
  calicut: 'kozhikode',
  cochin: 'kochi',
  trichy: 'tiruchirappalli',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  pondicherry: 'puducherry',
  pondichery: 'puducherry',
  hubli: 'hubballi',
  belgaum: 'belagavi',
  bellary: 'ballari',
  alleppey: 'alappuzha',
  tumkur: 'tumakuru',
  guruvayoor: 'guruvayur',
  tirupathi: 'tirupati',
  tirupathy: 'tirupati',
  tirupati: 'tirupati',
  tirupur: 'tiruppur',
  tuticorin: 'thoothukudi',
  tutukudi: 'thoothukudi',
  kanyakumari: 'kanniyakumari',
  murudeshwar: 'murdeshwar',
  rajahmundry: 'rajamahendravaram',
  gulbarga: 'kalaburagi',
  vizag: 'visakhapatnam',
  kutralam: 'courtallam',
  kutrallam: 'courtallam',
  coonor: 'coonoor',
  mahabubnagar: 'mahbubnagar',
  trivandrumairport: 'thiruvananthapuram',
  thiruvananthapuramairport: 'thiruvananthapuram',
};

const CITY_CACHE_TTL_MS = 30 * 60 * 1000;
type CityCacheEntry = {
  record: CachedCityRecord;
  expiresAt: number;
};

const cityCacheByNormalizedName = new Map<string, CityCacheEntry>();
const cityCacheById = new Map<number, CityCacheEntry>();

function normalizeAliasKey(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

export function normalizeCityName(value?: string | null): string {
  if (!value) return '';

  let normalized = String(value).toLowerCase();
  normalized = normalized.replace(/[.,()\-_/]/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();

  const locationAliasKey = normalizeAliasKey(normalized);
  const locationAliasResolved = LOCATION_ALIAS_MAP[locationAliasKey];
  if (locationAliasResolved) {
    return locationAliasResolved;
  }

  for (const pattern of LOCATION_SUFFIX_PATTERNS) {
    normalized = normalized.replace(pattern, ' ');
  }

  normalized = normalized.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  const aliasKey = normalizeAliasKey(normalized);
  const aliasResolved = CITY_ALIAS_MAP[aliasKey];
  return aliasResolved || normalized;
}

export function areCitiesEquivalent(input: CityComparisonInput): boolean {
  const idA = Number(input.cityIdA || 0);
  const idB = Number(input.cityIdB || 0);

  if (idA > 0 && idB > 0) {
    return idA === idB;
  }

  const normalizedA = normalizeCityName(input.cityNameA);
  const normalizedB = normalizeCityName(input.cityNameB);

  if (!normalizedA || !normalizedB) return false;
  return normalizedA === normalizedB;
}

export function buildCityLookupCandidates(value?: string | null): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  return Array.from(
    new Set(
      [raw, raw.split(',')[0] ?? '', raw.split('-')[0] ?? '', raw.split('|')[0] ?? '']
        .map((item) => String(item ?? '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeCityCacheKey(value?: string | null): string {
  return normalizeCityName(value).trim().toLowerCase();
}

function cacheCityRows(rows: any[]): void {
  const expiresAt = Date.now() + CITY_CACHE_TTL_MS;
  for (const row of rows as any[]) {
    const record: CachedCityRecord = {
      id: Number(row.id ?? 0),
      name: String(row.name ?? '').trim(),
      state_id: row.state_id != null ? Number(row.state_id) : null,
      tbo_city_code: row.tbo_city_code != null ? String(row.tbo_city_code).trim() : null,
      hobse_city_code: row.hobse_city_code != null ? String(row.hobse_city_code).trim() : null,
    };

    if (!record.id || !record.name) continue;

    const entry = { record, expiresAt };
    cityCacheById.set(record.id, entry);

    const normalizedName = normalizeCityCacheKey(record.name);
    const existing = normalizedName ? cityCacheByNormalizedName.get(normalizedName) : undefined;
    if (normalizedName && (
      !existing ||
      existing.expiresAt <= Date.now() ||
      record.id < existing.record.id
    )) {
      cityCacheByNormalizedName.set(normalizedName, entry);
    }
  }
}

function getCachedCityByName(key: string): CachedCityRecord | null {
  const entry = cityCacheByNormalizedName.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cityCacheByNormalizedName.delete(key);
    if (cityCacheById.get(entry.record.id) === entry) cityCacheById.delete(entry.record.id);
    return null;
  }
  return entry.record;
}

function getCachedCityById(id: number): CachedCityRecord | null {
  const entry = cityCacheById.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cityCacheById.delete(id);
    const normalizedName = normalizeCityCacheKey(entry.record.name);
    if (cityCacheByNormalizedName.get(normalizedName) === entry) {
      cityCacheByNormalizedName.delete(normalizedName);
    }
    return null;
  }
  return entry.record;
}

export function clearCityLookupCache(): void {
  cityCacheByNormalizedName.clear();
  cityCacheById.clear();
}

export async function resolveCityRecordByName(
  prisma: any,
  value?: string | null,
): Promise<CachedCityRecord | null> {
  const candidates = buildCityLookupCandidates(value);
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCityCacheKey(candidate);
    if (!normalizedCandidate) continue;

    const cached = getCachedCityByName(normalizedCandidate);
    if (cached) {
      return cached;
    }
  }

  const lookupTerms = Array.from(new Set(
    candidates.flatMap((candidate) => [
      String(candidate).trim(),
      normalizeCityCacheKey(candidate),
    ]).filter(Boolean),
  ));
  const rows = lookupTerms.length > 0
    ? await prisma.dvi_cities.findMany({
        where: {
          AND: [
            { status: 1 },
            { deleted: { in: [0, 1] } },
            { OR: lookupTerms.map((term) => ({ name: { startsWith: term } })) },
          ],
        },
        select: {
          id: true,
          name: true,
          state_id: true,
          tbo_city_code: true,
          hobse_city_code: true,
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      })
    : [];
  cacheCityRows(rows);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCityCacheKey(candidate);
    if (!normalizedCandidate) continue;
    const cached = getCachedCityByName(normalizedCandidate);
    if (cached) return cached;
  }

  return null;
}

export async function resolveCityNameById(
  prisma: any,
  cityId?: number | null,
): Promise<string> {
  const id = Number(cityId || 0);
  if (!id) return '';

  const cached = getCachedCityById(id);
  if (cached) return cached.name;

  const row = await prisma.dvi_cities.findFirst({
    where: {
      id,
      status: 1,
      deleted: { in: [0, 1] },
    },
    select: {
      id: true,
      name: true,
      state_id: true,
      tbo_city_code: true,
      hobse_city_code: true,
    },
  });
  if (row) cacheCityRows([row]);
  return String(row?.name ?? '').trim();
}
