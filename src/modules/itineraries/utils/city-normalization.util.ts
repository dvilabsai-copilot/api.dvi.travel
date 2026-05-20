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
];

const CITY_ALIAS_MAP: Record<string, string> = {
  trivandrum: 'thiruvananthapuram',
  trivandrumcity: 'thiruvananthapuram',
  tvm: 'thiruvananthapuram',
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  pondicherry: 'puducherry',
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
