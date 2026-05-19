/**
 * Validate hotspot availability semantics after full itinerary rebuild.
 *
 * Usage:
 *   npx ts-node -P tsconfig.json scripts/debug-available-hotspots-after-rebuild.ts
 *
 * Env:
 *   PLAN_ID=381
 *   ROUTE_ID=4333
 *   HOTSPOT_ID=219
 *   QUOTE_ID=DVI20260589
 *   API_BASE_URL=http://127.0.0.1:4006/api/v1
 *   DVI_TEST_TOKEN=<jwt>
 *   LOGIN_EMAIL=admin@dvi.co.in
 *   LOGIN_PASSWORD=...
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLAN_ID = Number(process.env.PLAN_ID || 381);
const ROUTE_ID = Number(process.env.ROUTE_ID || 4333);
const HOTSPOT_ID = Number(process.env.HOTSPOT_ID || 219);
const QUOTE_ID = String(process.env.QUOTE_ID || 'DVI20260589');
const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN = process.env.DVI_TEST_TOKEN || '';
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || 'admin@dvi.co.in';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'Keerthi@2404ias';

async function getToken(): Promise<string> {
  if (AUTH_TOKEN) return AUTH_TOKEN;
  const loginRes = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Login failed: ${loginRes.status} ${text}`);
  }
  const json: any = await loginRes.json();
  const token = json?.accessToken || json?.token || json?.data?.accessToken || json?.data?.token || '';
  if (!token) throw new Error('Login succeeded but no token returned');
  return token;
}

async function main() {
  console.log('\n=== INPUTS ===');
  console.log({ PLAN_ID, ROUTE_ID, HOTSPOT_ID, QUOTE_ID, API_BASE_URL });

  const token = await getToken();

  console.log('\n=== A) VISIBLE ITINERARY DETAILS STATE ===');
  const detailsRes = await fetch(`${API_BASE_URL}/itineraries/details/${QUOTE_ID}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!detailsRes.ok) {
    const txt = await detailsRes.text();
    throw new Error(`Details API failed: ${detailsRes.status} ${txt}`);
  }
  const details: any = await detailsRes.json();
  const days = Array.isArray(details?.days) ? details.days : [];

  const containsByDay: Array<{ dayNumber: number; routeId: number; contains: boolean }> = [];
  for (const day of days) {
    const dayNumber = Number(day?.dayNumber || 0);
    if (dayNumber < 1 || dayNumber > 4) continue;
    const segments = Array.isArray(day?.segments) ? day.segments : [];
    const contains = segments.some((seg: any) =>
      String(seg?.type || '').toLowerCase() === 'attraction'
      && Number(seg?.hotspotId ?? seg?.locationId ?? 0) === HOTSPOT_ID,
    );
    containsByDay.push({
      dayNumber,
      routeId: Number(day?.id || 0),
      contains,
    });
  }
  console.table(containsByDay);

  console.log('\n=== B) RAW DB ACTIVE ROWS FOR HOTSPOT ===');
  const rowsB = await prisma.$queryRawUnsafe<any[]>(`
SELECT
  route_hotspot_ID,
  itinerary_plan_ID,
  itinerary_route_ID,
  hotspot_ID,
  item_type,
  hotspot_plan_own_way,
  hotspot_order,
  status,
  deleted,
  createdon,
  updatedon
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = ${PLAN_ID}
  AND hotspot_ID = ${HOTSPOT_ID}
ORDER BY itinerary_route_ID, deleted, status, route_hotspot_ID;
  `);
  console.table(rowsB);

  console.log('\n=== C) ROUTE EXCLUSION STATE ===');
  const rowsC = await prisma.$queryRawUnsafe<any[]>(`
SELECT
  itinerary_route_ID,
  location_name,
  next_visiting_location,
  excluded_hotspot_ids
FROM dvi_itinerary_route_details
WHERE itinerary_plan_ID = ${PLAN_ID}
ORDER BY itinerary_route_ID;
  `);
  console.table(rowsC);

  console.log('\n=== D) getAvailableHotspots RESPONSE ===');
  const availableRes = await fetch(`${API_BASE_URL}/itineraries/hotspots/available/${ROUTE_ID}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!availableRes.ok) {
    const txt = await availableRes.text();
    throw new Error(`getAvailableHotspots failed: ${availableRes.status} ${txt}`);
  }

  const available: any[] = await availableRes.json();
  const row = available.find((h: any) => Number(h?.id || 0) === HOTSPOT_ID) || null;

  console.log('Pothamedu present in response:', !!row);
  if (!row) {
    console.log('[ABSENT] hotspot not returned by getAvailableHotspots');
  } else {
    console.log({
      id: Number(row?.id || 0),
      name: row?.name,
      availabilityStatus: row?.availabilityStatus || null,
      actionDisabled: row?.actionDisabled ?? null,
      alreadyAdded: row?.alreadyAdded ?? null,
      alreadyAddedOnOtherRoute: row?.alreadyAddedOnOtherRoute ?? null,
      availabilityReason: row?.availabilityReason || null,
      buttonLabel: row?.buttonLabel || null,
    });
  }
}

main()
  .catch((err) => {
    console.error('[ERROR]', err?.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
