import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type HotspotRow = {
  hotspot_ID: number;
  hotspot_name: string | null;
  hotspot_latitude: string | null;
  hotspot_longitude: string | null;
};

type ResolvedHotspot = {
  inputName: string;
  hotspot_ID: number;
  hotspot_name: string;
  hotspot_latitude: string | null;
  hotspot_longitude: string | null;
};

type RouteSlotInput = {
  from: string;
  to: string;
};

type RouteSlotResolved = {
  from: ResolvedHotspot;
  to: ResolvedHotspot;
};

type ResolveResult = {
  routeSlotsResolved: RouteSlotResolved[];
  optionalHotelEdgeSlotsResolved: RouteSlotResolved[];
  candidatesResolved: ResolvedHotspot[];
  unresolvedNames: string[];
  unresolvedRequiredNames: string[];
  unresolvedOptionalNames: string[];
  ambiguousNames: Array<{
    inputName: string;
    matches: HotspotRow[];
  }>;
};

const ROUTE_SLOTS: RouteSlotInput[] = [
  { from: 'Cheeyappara Waterfalls', to: 'Eravikulam National Park' },
  { from: 'Eravikulam National Park', to: 'Munnar Rose Garden' },
  { from: 'Munnar Rose Garden', to: 'Photo view point' },
  { from: 'Photo view point', to: 'Mattupetty Dam & Lake' },
  { from: 'Mattupetty Dam & Lake', to: 'Echo Point' },
];

const OPTIONAL_HOTEL_EDGE_SLOTS: RouteSlotInput[] = [
  { from: 'MUNNAR QUEEN', to: 'Cheeyappara Waterfalls' },
  { from: 'Echo Point', to: 'MUNNAR QUEEN' },
];

const CANDIDATES = [
  'Kolukkumalai Tea Estate (Munnar)',
  'Pothamedu View Point',
  'Attukad Waterfalls',
  'Lakkam Waterfalls',
  'Chinnar Wildlife Sanctuary',
  'Top Station',
  'Kundala Lake & Dam',
  'Anamudi Peak',
  'Blossam Hydal Park',
  'Clay Oven',
  'Botanical Garden Munnar',
  'Wonder Valley Adventure & Amusement Park (35 Activities)',
  'Carmelagiri Elephant Park',
  'Viripara Waterfalls',
];

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function normalizeForCompare(input: string): string {
  return decodeHtmlEntities(input)
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input: string): string[] {
  return normalizeForCompare(input)
    .split(' ')
    .filter((item) => item.length >= 3);
}

function safeMatches(inputName: string, rows: HotspotRow[]): HotspotRow[] {
  const inputNorm = normalizeForCompare(inputName);
  const inputTokens = tokenize(inputName);

  const exact = rows.filter((row) => normalizeForCompare(String(row.hotspot_name ?? '')) === inputNorm);
  if (exact.length > 0) {
    return exact;
  }

  const contains = rows.filter((row) => {
    const rowNorm = normalizeForCompare(String(row.hotspot_name ?? ''));
    return rowNorm.includes(inputNorm) || inputNorm.includes(rowNorm);
  });

  if (contains.length > 0) {
    return contains;
  }

  return rows.filter((row) => {
    const rowTokens = new Set(tokenize(String(row.hotspot_name ?? '')));
    if (!inputTokens.length) return false;
    const matched = inputTokens.filter((token) => rowTokens.has(token)).length;
    return matched >= Math.max(2, Math.floor(inputTokens.length * 0.6));
  });
}

function toResolved(inputName: string, row: HotspotRow): ResolvedHotspot {
  return {
    inputName,
    hotspot_ID: row.hotspot_ID,
    hotspot_name: row.hotspot_name ?? `Hotspot-${row.hotspot_ID}`,
    hotspot_latitude: row.hotspot_latitude,
    hotspot_longitude: row.hotspot_longitude,
  };
}

function printResolved(label: string, items: ResolvedHotspot[]) {
  console.log(`\n${label}:`);
  for (const item of items) {
    console.log(
      `- name="${item.inputName}" hotspot_ID=${item.hotspot_ID} hotspot_name="${item.hotspot_name}" lat=${item.hotspot_latitude ?? 'null'} lng=${item.hotspot_longitude ?? 'null'}`,
    );
  }
}

function printAmbiguous(item: { inputName: string; matches: HotspotRow[] }) {
  console.log(`\nAmbiguous name: "${item.inputName}"`);
  for (const row of item.matches) {
    console.log(
      `  - hotspot_ID=${row.hotspot_ID} hotspot_name="${row.hotspot_name ?? ''}" lat=${row.hotspot_latitude ?? 'null'} lng=${row.hotspot_longitude ?? 'null'}`,
    );
  }
}

export async function resolveHotspotTestIds(): Promise<ResolveResult> {
  const namesToResolve = new Set<string>();
  const optionalOnlyNames = new Set<string>(['MUNNAR QUEEN']);

  for (const slot of ROUTE_SLOTS) {
    namesToResolve.add(slot.from);
    namesToResolve.add(slot.to);
  }

  for (const slot of OPTIONAL_HOTEL_EDGE_SLOTS) {
    namesToResolve.add(slot.from);
    namesToResolve.add(slot.to);
  }

  for (const candidate of CANDIDATES) {
    namesToResolve.add(candidate);
  }

  const rows = await prisma.dvi_hotspot_place.findMany({
    where: { deleted: 0 },
    select: {
      hotspot_ID: true,
      hotspot_name: true,
      hotspot_latitude: true,
      hotspot_longitude: true,
    },
    orderBy: { hotspot_ID: 'asc' },
  });

  const byInput = new Map<string, ResolvedHotspot>();
  const unresolvedNames: string[] = [];
  const unresolvedRequiredNames: string[] = [];
  const unresolvedOptionalNames: string[] = [];
  const ambiguousNames: Array<{ inputName: string; matches: HotspotRow[] }> = [];

  for (const inputName of namesToResolve) {
    const matches = safeMatches(inputName, rows);

    if (!matches.length) {
      unresolvedNames.push(inputName);
      if (optionalOnlyNames.has(inputName)) {
        unresolvedOptionalNames.push(inputName);
      } else {
        unresolvedRequiredNames.push(inputName);
      }
      continue;
    }

    if (matches.length > 1) {
      ambiguousNames.push({ inputName, matches });
      continue;
    }

    byInput.set(inputName, toResolved(inputName, matches[0]));
  }

  const routeSlotsResolved: RouteSlotResolved[] = [];
  for (const slot of ROUTE_SLOTS) {
    const from = byInput.get(slot.from);
    const to = byInput.get(slot.to);
    if (from && to) {
      routeSlotsResolved.push({ from, to });
    }
  }

  const optionalHotelEdgeSlotsResolved: RouteSlotResolved[] = [];
  for (const slot of OPTIONAL_HOTEL_EDGE_SLOTS) {
    const from = byInput.get(slot.from);
    const to = byInput.get(slot.to);
    if (from && to) {
      optionalHotelEdgeSlotsResolved.push({ from, to });
    }
  }

  const candidatesResolved: ResolvedHotspot[] = [];
  for (const candidate of CANDIDATES) {
    const item = byInput.get(candidate);
    if (item) {
      candidatesResolved.push(item);
    }
  }

  return {
    routeSlotsResolved,
    optionalHotelEdgeSlotsResolved,
    candidatesResolved,
    unresolvedNames,
    unresolvedRequiredNames,
    unresolvedOptionalNames,
    ambiguousNames,
  };
}

async function main() {
  const result = await resolveHotspotTestIds();

  if (result.unresolvedRequiredNames.length || result.unresolvedOptionalNames.length) {
    console.log('\nMissing hotspot names (no safe match found):');
    for (const name of result.unresolvedRequiredNames) {
      console.log(`- ${name}`);
    }
  }

  if (result.ambiguousNames.length) {
    console.log('\nAmbiguous hotspot names found. Resolve these before continuing:');
    for (const item of result.ambiguousNames) {
      printAmbiguous(item);
    }
    process.exitCode = 1;
    return;
  }

  printResolved(
    'Route Slot Hotspots (required)',
    result.routeSlotsResolved.flatMap((slot) => [slot.from, slot.to]),
  );

  if (result.optionalHotelEdgeSlotsResolved.length) {
    printResolved(
      'Optional Hotel Edge Hotspots (MUNNAR QUEEN present in hotspot table)',
      result.optionalHotelEdgeSlotsResolved.flatMap((slot) => [slot.from, slot.to]),
    );
  } else {
    console.log('\nMatrix unavailable for hotel/source segment. MUNNAR QUEEN not resolved in dvi_hotspot_place.');
  }

  printResolved('Candidate Hotspots', result.candidatesResolved);

  const payload = {
    routeSlots: result.routeSlotsResolved.map((slot) => ({
      from_hotspot_id: slot.from.hotspot_ID,
      to_hotspot_id: slot.to.hotspot_ID,
      from_name: slot.from.hotspot_name,
      to_name: slot.to.hotspot_name,
    })),
    optionalHotelEdgeSlots: result.optionalHotelEdgeSlotsResolved.map((slot) => ({
      from_hotspot_id: slot.from.hotspot_ID,
      to_hotspot_id: slot.to.hotspot_ID,
      from_name: slot.from.hotspot_name,
      to_name: slot.to.hotspot_name,
    })),
    candidates: result.candidatesResolved.map((item) => ({
      hotspot_id: item.hotspot_ID,
      hotspot_name: item.hotspot_name,
      lat: item.hotspot_latitude,
      lng: item.hotspot_longitude,
    })),
  };

  console.log('\nResolved Payload JSON:');
  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed resolving route hotspot test IDs:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

