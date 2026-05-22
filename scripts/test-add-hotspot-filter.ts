/* eslint-disable no-console */

const API_URL = 'http://127.0.0.1:4006/api/v1/itineraries/hotspots/available-for-anchor';

type HotspotRow = {
  id: number;
  name: string;
  locationMap?: string | null;
};

function assertOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function toRows(payload: any): HotspotRow[] {
  if (Array.isArray(payload)) return payload as HotspotRow[];
  if (Array.isArray(payload?.hotspots)) return payload.hotspots as HotspotRow[];
  return [];
}

async function main(): Promise<void> {
  const token = String(process.env.TOKEN || '').trim();
  assertOrThrow(token.length > 0, 'TOKEN env variable is required');

  const payload = {
    planId: 382,
    routeId: 4409,
    anchorType: 'after_travel',
    anchorIndex: 0,
  } as const;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data: any = await res.json();
  if (!res.ok) {
    console.error('HTTP error:', res.status, data);
    process.exit(1);
  }

  const hotspots = toRows(data);
  const hotspotFilterMeta = Array.isArray(data) ? null : (data?.hotspotFilterMeta || null);

  const suspiciousTerms = [
    'tirupati',
    'venkateswara',
    'kapileswara',
    'iskcon',
    'padmavathi',
    'chandragiri',
  ];

  const suspiciousRows = hotspots.filter((row: HotspotRow) => {
    const hay = `${String(row?.name || '')} ${String(row?.locationMap || '')}`.toLowerCase();
    return suspiciousTerms.some((term) => hay.includes(term));
  });

  const chennaiRows = hotspots.filter((row: HotspotRow) => {
    const hay = `${String(row?.name || '')} ${String(row?.locationMap || '')}`.toLowerCase();
    return hay.includes('chennai') || hay.includes('kapaleeshwarar');
  });

  console.log('total hotspots returned:', hotspots.length);
  console.log('hotspotFilterMeta:', JSON.stringify(hotspotFilterMeta, null, 2));

  console.log('returned hotspots matching destination keywords:');
  if (suspiciousRows.length === 0) {
    console.log('(none)');
  } else {
    for (const row of suspiciousRows) {
      console.log(`- ${row.id} | ${row.name} | ${String(row.locationMap || '')}`);
    }
  }

  console.log('sample source/chennai hotspots:');
  if (chennaiRows.length === 0) {
    console.log('(none)');
  } else {
    for (const row of chennaiRows.slice(0, 10)) {
      console.log(`- ${row.id} | ${row.name} | ${String(row.locationMap || '')}`);
    }
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
