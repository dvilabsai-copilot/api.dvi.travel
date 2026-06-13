export interface CityComparisonInput {
  cityIdA?: number | null;
  cityIdB?: number | null;
  cityNameA?: string | null;
  cityNameB?: string | null;
}

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

export async function resolveCityRecordByName(
  prisma: any,
  value?: string | null,
): Promise<{ id: number; name: string; state_id: number | null } | null> {
  const candidates = buildCityLookupCandidates(value);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCityName(candidate);
    if (!normalizedCandidate) continue;

    const rows = await prisma.dvi_cities.findMany({
      where: {
        status: 1,
        deleted: { in: [0, 1] },
        name: { contains: candidate },
      },
      select: {
        id: true,
        name: true,
        state_id: true,
      },
      orderBy: { name: 'asc' },
      take: 25,
    });

    const exact = (rows as any[]).find(
      (row) => normalizeCityName(String(row.name ?? '')) === normalizedCandidate,
    );

    if (exact) {
      return {
        id: Number(exact.id),
        name: String(exact.name ?? '').trim(),
        state_id: exact.state_id != null ? Number(exact.state_id) : null,
      };
    }
  }

  return null;
}
