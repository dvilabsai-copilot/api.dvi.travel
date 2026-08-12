import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { resolvePersistedHotelIdentity } from '../src/modules/itineraries/utils/hotel-selection-identity.util';

const stay = {
  routeIds: [10145, 10146],
  stayDates: ['2026-08-12', '2026-08-13'],
  nights: 2,
  checkInDate: '2026-08-12',
  checkOutDate: '2026-08-14',
  stayKey: 'offline:211:540:3:2026-08-12_to_2026-08-14',
};

const candidates = stay.routeIds.map((routeId, index) => ({
  routeId,
  itineraryRouteId: routeId,
  date: stay.stayDates[index],
  provider: 'offline',
  hotelCode: '211',
  canonicalHotelId: 211,
  hotelId: 211,
  hotelName: 'GREENRIDGE',
  roomType: 'Deluxe Room',
  mealPlan: 'CP',
  roomId: 540,
  roomTypeId: 3,
  rateOptionId: 'offline:211:540:3:2026-08-12:2026-08-14',
  optionKey: 'offline:211:540:3:2026-08-12:2026-08-14',
  pricePerNight: 2500,
  totalStayPrice: 5000,
  totalPrice: 5000,
  currency: 'INR',
  isSelectable: true,
  isBookable: true,
}));

function createService(resolveOfflineIntentCandidates: () => Promise<any[]>) {
  const service = Object.create(ItinerariesService.prototype) as any;
  let persisted = false;
  let persistedPayloads: any[] = [];
  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082', preferred_room_count: 1 }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') }),
    },
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => candidates.map((candidate) => ({
        itinerary_route_id: candidate.routeId,
        itinerary_route_date: new Date(`${candidate.date}T00:00:00.000Z`),
        hotel_id: 211,
        hotel_code: '211',
        hotel_provider: 'offline',
        selected_rate_option_id: candidate.rateOptionId,
        selected_price_per_night: candidate.pricePerNight,
        selected_total_price: candidate.totalStayPrice,
        selected_currency: 'INR',
        selected_price_snapshot: JSON.stringify({
          provider: 'offline',
          hotelId: 211,
          canonicalHotelId: 211,
          hotelCode: '211',
          providerHotelCode: '211',
          hotelName: 'GREENRIDGE',
          category: 2,
          rateOptionId: candidate.rateOptionId,
          roomId: 540,
          roomTypeId: 3,
          roomType: 'Deluxe Room',
          mealPlan: 'CP',
          pricePerNight: 2500,
          totalStayPrice: 5000,
        }),
      })),
    },
    dvi_hotel: {
      findMany: async () => [{ hotel_id: 211, hotel_name: 'GREENRIDGE', hotel_category: 2 }],
    },
  };
  service.hotelAvailabilitySnapshotService = { getActiveRows: async () => [] };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => stay,
    previewStayExtension: async () => ({ canBookMultiNight: true, blocked: false }),
  };
  service.resolveOfflineIntentCandidates = resolveOfflineIntentCandidates;
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
    bulkSaveHotels: async (_planId: number, payloads: any[]) => {
      persistedPayloads = payloads;
      persisted = true;
    },
  };
  return { service, wasPersisted: () => persisted, persistedPayloads: () => persistedPayloads };
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  planId: 10040,
  routeId: 10145,
  groupType: 1,
  selectionIntent: 'HOTEL',
  provider: 'offline',
  hotelCode: '211',
  canonicalHotelId: 211,
  hotelId: 211,
  routeDate: '2026-08-12',
  ...overrides,
});

test('offline HOTEL preview returns current authoritative selections without persistence', async () => {
  const { service, wasPersisted } = createService(async () => candidates);

  const result = await service.previewHotelIntent(payload());

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.affectedRouteIds, [10145, 10146]);
  assert.deepEqual(result.selections.map((selection: any) => selection.routeDate), ['2026-08-12', '2026-08-13']);
  assert.equal(result.selections[0].selectedRateOptionId, 'offline:211:540:3:2026-08-12:2026-08-14');
  assert.equal(wasPersisted(), false);
});

test('offline preview returns NO_AVAILABILITY and does not open a persistence path', async () => {
  const { service, wasPersisted } = createService(async () => {
    throw new BadRequestException({ code: 'HOTEL_NO_AVAILABILITY', status: 'NO_AVAILABILITY' });
  });

  const result = await service.previewHotelIntent(payload());

  assert.equal(result.status, 'NO_AVAILABILITY');
  assert.equal(result.retryable, false);
  assert.equal(wasPersisted(), false);
});

test('offline catalog failure remains REFRESH_FAILED', async () => {
  const { service, wasPersisted } = createService(async () => {
    throw new Error('offline catalog database unavailable');
  });

  const result = await service.previewHotelIntent(payload());

  assert.equal(result.status, 'REFRESH_FAILED');
  assert.equal(result.retryable, true);
  assert.equal(wasPersisted(), false);
});

test('database duplicate-key failure is retryable refresh failure, not supplier unavailability', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };
  service.selectHotelIntentUnlocked = async () => {
    throw { code: 'P2002', message: 'Unique constraint failed on uq_hotel_cache_key' };
  };

  const result = await service.previewHotelIntent(payload());

  assert.equal(result.status, 'REFRESH_FAILED');
  assert.equal(result.retryable, true);
  assert.equal(result.code, 'P2002');
});

test('stale offline rate identity is rejected instead of reused', async () => {
  const { service } = createService(async () => candidates);

  const result = await service.previewHotelIntent(payload({
    selectionIntent: 'RATE_OPTION',
    rateOptionId: 'offline:211:540:3:2026-08-11:2026-08-12',
  }));

  assert.equal(result.status, 'NO_AVAILABILITY');
});

test('preview from either night preserves the same continuous stay', async () => {
  const { service } = createService(async () => candidates);

  const dayOne = await service.previewHotelIntent(payload({ routeId: 10145, routeDate: '2026-08-12' }));
  const dayTwo = await service.previewHotelIntent(payload({ routeId: 10146, routeDate: '2026-08-13' }));

  assert.deepEqual(dayOne.affectedRouteIds, dayTwo.affectedRouteIds);
  assert.deepEqual(dayOne.logicalStay.stayDates, dayTwo.logicalStay.stayDates);
});

test('STAAH HOTEL preview resolves the canonical hotel id to the supplier property code', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  const refreshedCodes: string[] = [];
  const staahCandidates = stay.routeIds.map((routeId, index) => ({
    routeId,
    itineraryRouteId: routeId,
    date: stay.stayDates[index],
    provider: 'staah',
    canonicalHotelId: 44596,
    hotelId: 44596,
    hotelCode: '44596',
    providerHotelCode: 'STAAHTESTHOTELPROD',
    hotelName: 'STAAH TEST HOTEL PROD',
    roomType: 'Deluxe Room',
    mealPlan: 'CP',
    rateOptionId: `STAAH-STAAHTESTHOTELPROD-DELUXEROOM-CP_PLAN-${stay.stayDates[index].replaceAll('-', '')}`,
    optionKey: `STAAH-STAAHTESTHOTELPROD-DELUXEROOM-CP_PLAN-${stay.stayDates[index].replaceAll('-', '')}`,
    pricePerNight: 1850,
    totalPrice: 1850,
    isSelectable: true,
    isBookable: true,
  }));

  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082' }),
    },
    dvi_hotel: {
      findUnique: async () => ({
        hotel_id: 44596,
        staah_property_id: 'STAAHTESTHOTELPROD',
        axisrooms_property_id: null,
      }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') }),
    },
  };
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => stay,
    previewStayExtension: async () => ({ canBookMultiNight: true, blocked: false }),
  };
  service.hotelDetailsTboService = {
    getSelectedHotelRates: async (_quoteId: string, _routeId: number, _provider: string, hotelCode: string) => {
      refreshedCodes.push(hotelCode);
      return { hotels: [{}] };
    },
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => staahCandidates,
  };

  const result = await service.previewHotelIntent({
    planId: 10040,
    routeId: 10145,
    groupType: 1,
    selectionIntent: 'HOTEL',
    provider: 'staah',
    hotelCode: '44596',
    canonicalHotelId: 44596,
    hotelId: 44596,
    routeDate: '2026-08-12',
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(refreshedCodes, ['STAAHTESTHOTELPROD', 'STAAHTESTHOTELPROD']);
  assert.deepEqual(result.selections.map((selection: any) => selection.providerHotelCode), [
    'STAAHTESTHOTELPROD',
    'STAAHTESTHOTELPROD',
  ]);
});

test('TBO RATE_OPTION preview keeps the commercial room while replacing an expired session token', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  const staleBookingCode = '1313362!TB!1!TB!old-session!TB!N!TB!AFF!';
  const freshBookingCode = '1313362!TB!1!TB!fresh-session!TB!N!TB!AFF!';
  const selectionKey = 'tbo:1313362:1';
  const tboStay = {
    routeIds: [10145],
    stayDates: ['2026-08-12'],
    nights: 1,
    checkInDate: '2026-08-12',
    checkOutDate: '2026-08-13',
    stayKey: 'tbo:1313362:2026-08-12_to_2026-08-13',
  };
  const freshCandidate = {
    routeId: 10145,
    itineraryRouteId: 10145,
    date: '2026-08-12',
    provider: 'tbo',
    hotelCode: '1313362',
    providerHotelCode: '1313362',
    hotelName: 'BLACKBERRY HILLS RETREAT & SPA',
    roomType: 'Garden Suite',
    mealPlan: 'MAP',
    rateOptionId: freshBookingCode,
    optionKey: freshBookingCode,
    bookingCode: freshBookingCode,
    searchReference: freshBookingCode,
    selectionKey,
    pricePerNight: 20951.95,
    totalPrice: 20951.95,
    isSelectable: true,
    isBookable: true,
  };

  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082' }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') }),
    },
  };
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => tboStay,
    previewStayExtension: async () => ({ canBookMultiNight: true, blocked: false }),
  };
  service.hotelDetailsTboService = {
    getSelectedHotelRates: async () => ({ hotels: [freshCandidate] }),
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => [freshCandidate],
  };

  const result = await service.previewHotelIntent({
    planId: 10040,
    routeId: 10145,
    groupType: 3,
    selectionIntent: 'RATE_OPTION',
    provider: 'tbo',
    hotelCode: '1313362',
    providerHotelCode: '1313362',
    rateOptionId: staleBookingCode,
    optionKey: staleBookingCode,
    selectionKey,
    routeDate: '2026-08-12',
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].selectionKey, selectionKey);
  assert.equal(result.selections[0].selectedRateOptionId, freshBookingCode);
  assert.equal(result.selections[0].supplierBookingCode, freshBookingCode);
});

test('offline confirm returns DB-verified identity even when request name is contradictory', async () => {
  const { service } = createService(async () => candidates);

  const result = await service.selectHotelIntent(payload({ hotelName: 'STAAH TEST HOTEL PROD' }));

  assert.deepEqual(result.selections.map((selection: any) => ({
    routeId: selection.routeId,
    provider: selection.provider,
    hotelId: selection.hotelId,
    canonicalHotelId: selection.canonicalHotelId,
    hotelCode: selection.hotelCode,
    hotelName: selection.hotelName,
    category: selection.category,
  })), [
    { routeId: 10145, provider: 'offline', hotelId: 211, canonicalHotelId: 211, hotelCode: '211', hotelName: 'GREENRIDGE', category: 2 },
    { routeId: 10146, provider: 'offline', hotelId: 211, canonicalHotelId: 211, hotelCode: '211', hotelName: 'GREENRIDGE', category: 2 },
  ]);
});

test('offline confirm preserves route-night pricing in persistence payload and saved response', async () => {
  const rateOptionId = 'offline:435:1247:1051:2026-08-12:2026-08-14';
  const nightlyRates = [
    { date: '2026-08-12', baseAmount: 4750, marginPercentage: 20, marginAmount: 950, sellAmount: 5700 },
    { date: '2026-08-13', baseAmount: 4750, marginPercentage: 20, marginAmount: 950, sellAmount: 5700 },
  ];
  const spriseCandidates = stay.routeIds.map((routeId, index) => ({
    ...candidates[index],
    routeId,
    itineraryRouteId: routeId,
    date: stay.stayDates[index],
    hotelCode: '435',
    canonicalHotelId: 435,
    hotelId: 435,
    hotelName: 'SPRISE MUNNAR RESORT & SPA',
    roomId: 1247,
    roomTypeId: 1051,
    roomType: 'Marvellous Mountain View',
    rateOptionId,
    optionKey: rateOptionId,
    basePricePerNight: 4750,
    baseTotalPrice: 9500,
    hotelMarginPercentage: 20,
    hotelMarginAmount: 950,
    hotelMarginTotalAmount: 1900,
    pricePerNight: 5700,
    totalPrice: 11400,
    totalStayPrice: 11400,
    numberOfNights: 2,
    nightlyRates,
  }));
  const { service, persistedPayloads } = createService(async () => spriseCandidates);
  service.prisma.dvi_itinerary_plan_hotel_details.findMany = async () => stay.routeIds.map((routeId, index) => ({
    itinerary_route_id: routeId,
    itinerary_route_date: new Date(`${stay.stayDates[index]}T00:00:00.000Z`),
    hotel_id: 435,
    hotel_code: '435',
    hotel_provider: 'offline',
    selected_rate_option_id: rateOptionId,
    selected_price_per_night: 5700,
    selected_total_price: 5700,
    selected_currency: 'INR',
    hotel_margin_percentage: 20,
    hotel_margin_rate: 950,
    selected_price_snapshot: JSON.stringify({
      provider: 'offline', canonicalHotelId: 435, hotelId: 435, hotelCode: '435',
      hotelName: 'SPRISE MUNNAR RESORT & SPA', rateOptionId,
      roomId: 1247, roomTypeId: 1051, roomType: 'Marvellous Mountain View', mealPlan: 'CP',
      pricingScope: 'ROUTE_NIGHT', basePricePerNight: 4750, baseTotalPrice: 4750,
      hotelMarginPercentage: 20, hotelMarginAmount: 950, hotelMarginTotalAmount: 950,
      pricePerNight: 5700, totalPrice: 5700, numberOfNights: 1,
      nightlyRates: [nightlyRates[index]],
    }),
  }));
  service.prisma.dvi_hotel.findMany = async () => [
    { hotel_id: 435, hotel_name: 'SPRISE MUNNAR RESORT & SPA', hotel_category: 4 },
  ];

  const result = await service.selectHotelIntent(payload({
    hotelCode: '435', canonicalHotelId: 435, hotelId: 435,
  }));

  assert.equal(persistedPayloads().length, 2);
  persistedPayloads().forEach((saved, index) => {
    assert.equal(saved.basePricePerNight, 4750);
    assert.equal(saved.baseTotalPrice, 4750);
    assert.equal(saved.hotelMarginPercentage, 20);
    assert.equal(saved.hotelMarginAmount, 950);
    assert.equal(saved.hotelMarginTotalAmount, 950);
    assert.equal(saved.pricePerNight, 5700);
    assert.equal(saved.totalPrice, 5700);
    assert.equal(saved.numberOfNights, 1);
    assert.deepEqual(saved.nightlyRates, [nightlyRates[index]]);
  });
  result.selections.forEach((selection: any, index: number) => {
    assert.equal(selection.basePricePerNight, 4750);
    assert.equal(selection.baseTotalPrice, 4750);
    assert.equal(selection.hotelMarginPercentage, 20);
    assert.equal(selection.hotelMarginAmount, 950);
    assert.equal(selection.hotelMarginTotalAmount, 950);
    assert.equal(selection.pricePerNight, 5700);
    assert.equal(selection.totalPrice, 5700);
    assert.deepEqual(selection.nightlyRates, [nightlyRates[index]]);
    assert.equal(selection.selectedPriceSnapshot.rateOptionId, rateOptionId);
  });
  assert.equal(result.totals.totalPrice, 11400);
});

test('wrong snapshot name cannot override the persisted offline master identity', () => {
  const identity = resolvePersistedHotelIdentity({
    hotel_id: 211,
    hotel_code: '211',
    hotel_provider: 'offline',
    selected_rate_option_id: 'offline:211:540:3:2026-08-12:2026-08-14',
    selected_price_snapshot: JSON.stringify({
      provider: 'offline',
      canonicalHotelId: 211,
      hotelCode: '211',
      hotelName: 'STAAH TEST HOTEL PROD',
      category: 4,
    }),
  }, {
    hotel_id: 211,
    hotel_name: 'GREENRIDGE',
    hotel_category: 2,
  });

  assert.equal(identity.consistent, false);
  assert.equal(identity.hotelName, 'GREENRIDGE');
  assert.equal(identity.category, 2);
  assert.deepEqual(identity.mismatches, ['snapshotHotelName', 'snapshotCategory']);
});

test('offline persisted identity decodes HTML entities without creating a false name mismatch', () => {
  const identity = resolvePersistedHotelIdentity({
    hotel_id: 435,
    hotel_code: '435',
    hotel_provider: 'offline',
    selected_rate_option_id: 'offline:435:1247:1051:2026-08-12:2026-08-14',
    selected_price_snapshot: JSON.stringify({
      provider: 'offline',
      canonicalHotelId: 435,
      hotelCode: '435',
      hotelName: 'SPRISE MUNNAR RESORT & SPA',
      category: 4,
    }),
  }, {
    hotel_id: 435,
    hotel_name: 'SPRISE MUNNAR RESORT &amp; SPA',
    hotel_category: 4,
  });

  assert.equal(identity.consistent, true);
  assert.equal(identity.hotelName, 'SPRISE MUNNAR RESORT & SPA');
  assert.deepEqual(identity.mismatches, []);
});
