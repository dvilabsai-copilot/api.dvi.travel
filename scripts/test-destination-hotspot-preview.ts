/* eslint-disable no-console */

const API_URL = 'http://127.0.0.1:4006/api/v1/itineraries/382/manual-hotspot/preview';
const SELECTED_DEST_HOTSPOT_ID = 204;
const DEST_ANCHOR_HOTSPOT_ID = 201;
const SOURCE_HOTSPOT_ID = 11;

function assertOrThrow(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function rowHotspotId(row: any): number {
  const value = Number(row?.hotspot_ID ?? row?.locationId ?? row?.hotspotId ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function isAttraction(row: any): boolean {
  return String(row?.type || '').toLowerCase() === 'attraction' || Number(row?.item_type || 0) === 4;
}

async function main(): Promise<void> {
  const token = String(process.env.TOKEN || '').trim();
  assertOrThrow(token.length > 0, 'TOKEN env variable is required');

  const payload = {
    routeId: 4409,
    hotspotId: 204,
    anchorType: 'after_travel',
    anchorIndex: 0,
    allowTopPriorityRemoval: false,
    selectedHotspotIds: [204],
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

  const manualInsertionFit = data?.manualInsertionFit || {};
  const fullTimeline = Array.isArray(data?.fullTimeline) ? data.fullTimeline : [];

  console.log('code:', String(data?.code || ''));
  console.log('manualInsertionFit.hotspotCityContext:', String(manualInsertionFit?.hotspotCityContext || ''));
  console.log('manualInsertionFit.destinationInsertionMode:', Boolean(manualInsertionFit?.destinationInsertionMode));
  console.log('manualInsertionFit.destinationAnchorHotspotId:', Number(manualInsertionFit?.destinationAnchorHotspotId || 0) || null);
  console.log('manualInsertionFit.chosenSlot:', manualInsertionFit?.chosenSlot || null);

  console.log('fullTimeline order:');
  for (let i = 0; i < fullTimeline.length; i += 1) {
    const row = fullTimeline[i] || {};
    console.log([
      i,
      String(row?.type || row?.item_type || ''),
      String(row?.text || row?.name || ''),
      rowHotspotId(row) || null,
      String(row?.timeRange || ''),
    ].join(' | '));
  }

  assertOrThrow(
    String(manualInsertionFit?.hotspotCityContext || '').toUpperCase() === 'DESTINATION_CITY',
    'Expected manualInsertionFit.hotspotCityContext to be DESTINATION_CITY',
  );

  assertOrThrow(
    manualInsertionFit?.destinationInsertionMode === true,
    'Expected manualInsertionFit.destinationInsertionMode to be true',
  );

  const selectedAttractionIndex = fullTimeline.findIndex(
    (row: any) => isAttraction(row) && rowHotspotId(row) === SELECTED_DEST_HOTSPOT_ID,
  );
  const destinationAnchorIndex = fullTimeline.findIndex(
    (row: any) => isAttraction(row) && rowHotspotId(row) === DEST_ANCHOR_HOTSPOT_ID,
  );
  const sourceAttractionIndex = fullTimeline.findIndex(
    (row: any) => isAttraction(row) && rowHotspotId(row) === SOURCE_HOTSPOT_ID,
  );

  assertOrThrow(selectedAttractionIndex >= 0, 'Expected timeline to contain hotspot_ID=204 as attraction');
  if (destinationAnchorIndex >= 0) {
    assertOrThrow(
      selectedAttractionIndex > destinationAnchorIndex,
      'Expected hotspot_ID=204 to appear after hotspot_ID=201 in timeline',
    );
  }
  if (sourceAttractionIndex >= 0) {
    assertOrThrow(
      selectedAttractionIndex > sourceAttractionIndex,
      'Expected hotspot_ID=204 to not be inserted before Parthasarathy hotspot',
    );
  }

  const hotelIndex = fullTimeline.findIndex((row: any) => String(row?.type || '').toLowerCase() === 'hotel' || Number(row?.item_type || 0) === 6);
  if (hotelIndex >= 0) {
    assertOrThrow(
      selectedAttractionIndex < hotelIndex,
      'Expected hotspot_ID=204 to appear before hotel/check-in',
    );
  }

  const code = String(data?.code || '').toUpperCase();
  assertOrThrow(
    code !== 'MATRIX_DATA_MISSING' && code !== 'MANUAL_HOTSPOT_MATRIX_DATA_MISSING',
    'Expected response not to return MATRIX_DATA_MISSING for destination-side insertion',
  );

  const missingMatrixBuildSuggestion = data?.missingMatrixBuildSuggestion || data?.resolution?.missingMatrixBuildSuggestion;
  assertOrThrow(
    !missingMatrixBuildSuggestion,
    'Expected no missingMatrixBuildSuggestion for destination hotel-side insertion',
  );

  const attemptedSlotLabel = String(
    manualInsertionFit?.chosenSlot?.attemptedSlotLabel
    || manualInsertionFit?.bestSlot?.attemptedSlotLabel
    || ''
  );
  assertOrThrow(
    attemptedSlotLabel.includes('Sri Kapileswara Swamy Temple')
      && attemptedSlotLabel.includes('Goovindraja Temple')
      && attemptedSlotLabel.includes('Hotel'),
    'Expected attempted slot label to contain "Sri Kapileswara Swamy Temple | Tirupati -> Goovindraja Temple -> Hotel"',
  );

  console.log('All assertions passed.');
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
