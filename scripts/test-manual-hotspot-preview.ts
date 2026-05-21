/* eslint-disable no-console */

type TimelineRow = {
  index: number;
  type: string;
  text: string;
  fromName: string;
  toName: string;
  timeRange: string;
  matrixTravelLeg: string;
  hotspot_ID: number | null;
  locationId: number | null;
  displayFromName?: string;
  displayToName?: string;
};

const API_URL = 'http://127.0.0.1:4006/api/v1/itineraries/382/manual-hotspot/preview';
const SELECTED_HOTSPOT_ID = 4;
const SELECTED_HOTSPOT_NAME = 'Kapaleeshwarar Temple';

function assertOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function rowHotspotId(row: any): number | null {
  const value = Number(row?.hotspot_ID ?? row?.locationId ?? row?.hotspotId ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isAttraction(row: any): boolean {
  return String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
}

function isHotelLike(row: any): boolean {
  const type = String(row?.type || '').toLowerCase();
  const text = String(row?.text || row?.name || '').toLowerCase();
  return type === 'hotel' || Number(row?.item_type || 0) === 6 || text.includes('check-in at hotel');
}

function printTimeline(rows: any[]): void {
  const mapped: TimelineRow[] = rows.map((row: any, index: number) => ({
    index,
    type: String(row?.type || ''),
    text: String(row?.text || row?.name || ''),
    fromName: String(row?.fromName || row?.displayFromName || row?.from || ''),
    toName: String(row?.toName || row?.displayToName || row?.to || ''),
    timeRange: String(row?.timeRange || ''),
    matrixTravelLeg: String(row?.matrixTravelLeg || ''),
    hotspot_ID: rowHotspotId({ hotspot_ID: row?.hotspot_ID }),
    locationId: rowHotspotId({ locationId: row?.locationId }),
    displayFromName: String(row?.displayFromName || ''),
    displayToName: String(row?.displayToName || ''),
  }));

  console.log('fullTimeline:');
  for (const row of mapped) {
    console.log(
      [
        row.index,
        row.type,
        row.text,
        row.fromName,
        row.toName,
        row.timeRange,
        row.matrixTravelLeg,
        row.hotspot_ID,
        row.locationId,
      ].join(' | '),
    );
  }
}

async function main(): Promise<void> {
  const token = String(process.env.TOKEN || '').trim();
  assertOrThrow(token.length > 0, 'TOKEN env variable is required');

  console.log('[ManualTimelineBuild] api_test_start');

  const payload = {
    routeId: 4409,
    hotspotId: 4,
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    selectedHotspotIds: [4],
  };

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data: any = await response.json();
  if (!response.ok) {
    console.error('HTTP error:', response.status, data);
    process.exit(1);
  }

  const fullTimeline = Array.isArray(data?.fullTimeline) ? data.fullTimeline : [];
  const newHotspot = data?.newHotspot || null;

  console.log('response.code:', data?.code || '');
  console.log('response.newHotspot:', JSON.stringify(newHotspot, null, 2));
  printTimeline(fullTimeline);

  const cAttractionIndex = fullTimeline.findIndex((row: any) => isAttraction(row) && rowHotspotId(row) === SELECTED_HOTSPOT_ID);
  assertOrThrow(cAttractionIndex >= 0, 'Assertion failed: fullTimeline must contain hotspot_ID=4 attraction row');

  const aToCIndex = fullTimeline.findIndex((row: any) => String(row?.matrixTravelLeg || '') === 'A_TO_C');
  const cToBIndex = fullTimeline.findIndex((row: any) => String(row?.matrixTravelLeg || '') === 'C_TO_B');
  assertOrThrow(aToCIndex >= 0, 'Assertion failed: A_TO_C row missing');
  assertOrThrow(cToBIndex >= 0, 'Assertion failed: C_TO_B row missing');
  assertOrThrow(aToCIndex < cAttractionIndex && cAttractionIndex < cToBIndex, 'Assertion failed: hotspot_ID=4 must appear between A_TO_C and C_TO_B');

  const aToC = fullTimeline[aToCIndex] || {};
  const cToB = fullTimeline[cToBIndex] || {};

  const aToCTargets = [
    String(aToC?.toName || '').trim(),
    String(aToC?.displayToName || '').trim(),
    String(aToC?.text || aToC?.name || '').trim(),
  ].map((v) => v.toLowerCase());
  const cNameLower = SELECTED_HOTSPOT_NAME.toLowerCase();
  assertOrThrow(
    aToCTargets.some((v) => v.includes(cNameLower)),
    'Assertion failed: A_TO_C toName/displayToName/text must point to Kapaleeshwarar Temple',
  );

  const cToBSources = [
    String(cToB?.fromName || '').trim(),
    String(cToB?.displayFromName || '').trim(),
    String(cToB?.from || '').trim(),
  ].map((v) => v.toLowerCase());
  assertOrThrow(
    cToBSources.some((v) => v.includes(cNameLower)),
    'Assertion failed: C_TO_B fromName/displayFromName must point to Kapaleeshwarar Temple',
  );

  const hotelIndex = fullTimeline.findIndex((row: any) => isHotelLike(row));
  if (hotelIndex >= 0) {
    const hasManualAfterHotel = fullTimeline.some((row: any, index: number) => index > hotelIndex && rowHotspotId(row) === SELECTED_HOTSPOT_ID);
    assertOrThrow(!hasManualAfterHotel, 'Assertion failed: manual hotspot appears after hotel');
  }

  console.log('All assertions passed.');
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
