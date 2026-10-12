export function tollCityAliasKey(value?: string | null): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-IN')
    .replace(/\s+/g, ' ');
}

export function isTollAirportLocation(value?: string | null): boolean {
  return tollCityAliasKey(value).includes('airport');
}

function tollCityAliasCompactKey(value?: string | null): string {
  return tollCityAliasKey(value).replace(/[.,()&'\-_\/]/g, '').replace(/\s+/g, '');
}

export async function resolveTollCity(
  prisma: any,
  value?: string | null,
): Promise<string | null> {
  const aliasKey = tollCityAliasKey(value);
  if (!aliasKey) return null;

  const row = await prisma.dvi_toll_city_aliases.findFirst({
    where: { alias_key: aliasKey, status: 1, deleted: 0 },
    select: { canonical_city: true },
  });

  const compactKey = tollCityAliasCompactKey(value);
  const fallback = !row && compactKey && compactKey !== aliasKey
    ? await prisma.dvi_toll_city_aliases.findFirst({
      where: { alias_key: compactKey, status: 1, deleted: 0 },
      select: { canonical_city: true },
    })
    : null;

  const canonical = String(row?.canonical_city ?? fallback?.canonical_city ?? '').trim();
  return canonical || null;
}

export async function resolveTollCityPair(
  prisma: any,
  source: string,
  destination: string,
): Promise<{ source: string; destination: string } | null> {
  const [sourceCity, destinationCity] = await Promise.all([
    resolveTollCity(prisma, source),
    resolveTollCity(prisma, destination),
  ]);

  if (!sourceCity || !destinationCity) return null;
  return { source: sourceCity, destination: destinationCity };
}

async function resolveTollLocation(
  prisma: any,
  value?: string | null,
): Promise<string | null> {
  const aliasKey = tollCityAliasKey(value);
  if (!aliasKey) return null;

  const row = await prisma.dvi_toll_city_aliases.findFirst({
    where: { alias_key: aliasKey, status: 1, deleted: 0 },
    select: { alias_name: true, canonical_city: true },
  });

  const compactKey = tollCityAliasCompactKey(value);
  const fallback = !row && compactKey && compactKey !== aliasKey
    ? await prisma.dvi_toll_city_aliases.findFirst({
      where: { alias_key: compactKey, status: 1, deleted: 0 },
      select: { alias_name: true, canonical_city: true },
    })
    : null;

  const resolved = row ?? fallback;
  const aliasName = String(resolved?.alias_name ?? '').trim();
  const canonicalCity = String(resolved?.canonical_city ?? '').trim();
  if (!canonicalCity) return null;

  return isTollAirportLocation(aliasName) ? aliasName : canonicalCity;
}

export async function resolveTollLocationPair(
  prisma: any,
  source: string,
  destination: string,
): Promise<{ source: string; destination: string } | null> {
  const [sourceLocation, destinationLocation] = await Promise.all([
    resolveTollLocation(prisma, source),
    resolveTollLocation(prisma, destination),
  ]);

  if (!sourceLocation || !destinationLocation) return null;
  return { source: sourceLocation, destination: destinationLocation };
}
