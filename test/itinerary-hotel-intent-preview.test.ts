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
  const cancelledHolds: any[] = [];
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
  service.hotelBlockingService = {
    cancelHoldsAfterHotelChange: async (request: any) => {
      assert.equal(persisted, true, 'holds must only be cancelled after a successful save');
      cancelledHolds.push(request);
    },
  };
  return { service, wasPersisted: () => persisted, persistedPayloads: () => persistedPayloads, cancelledHolds };
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

test('offline preview prices each night with one extra bed and only the selected meals', async () => {
  for (const mealPlan of ['CP', 'MAP']) {
    const mealCosts = mealPlan === 'CP' ? [0, 0] : [3250, 3000];
    const nightlyRates = stay.stayDates.map((date, index) => ({
      date,
      baseAmount: [5950, 7125][index],
      roomCost: [5200, 6200][index],
      extraBedAmount: [750, 925][index],
      marginPercentage: 5,
      mealPlanBreakdown: { mealPlanCode: mealPlan, totalMealPlanCost: mealCosts[index] },
    }));
    const { service, wasPersisted } = createService(async () => candidates.map(candidate => ({
      ...candidate, mealPlan, roomCount: 2, extraBedAmount: 1675, nightlyRates,
    })));

    const result = await service.previewHotelIntent(payload({ selectionIntent: 'MEAL_PLAN', mealPlanCode: mealPlan }));

    assert.equal(result.status, 'AVAILABLE');
    assert.deepEqual(result.selections.map(selection => selection.pricePerNight),
      mealPlan === 'CP' ? [6247.5, 7481.25] : [9497.5, 10481.25]);
    assert.deepEqual(result.selections.map(selection => selection.totalExtraBedCost), [750, 925]);
    assert.deepEqual(result.selections.map(selection => selection.hotelMealPlanCost), mealCosts);
    assert.deepEqual(result.selections.map(selection => selection.totalRoomCost), [5200, 6200]);
    assert.equal(wasPersisted(), false);
  }
});

test('offline card preview resolves a saved master ID using the master catalogue code', async () => {
  const { service } = createService(async () => []);
  service.prisma.dvi_hotel.findUnique = async () => ({ hotel_id: 211, hotel_code: '173' });
  service.resolveOfflineIntentCandidates = async (_plan, _stay, request) => {
    assert.equal(request.canonicalHotelId, 211);
    assert.equal(request.hotelCode, '173');
    return candidates.map(candidate => ({ ...candidate, hotelCode: '173', providerHotelCode: '173' }));
  };

  const result = await service.previewHotelIntent(payload({ hotelCode: '211', providerHotelCode: '211' }));
  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map(selection => selection.hotelCode), ['173', '173']);
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

test('stale offline rate identity is replaced when the hotel remains available', async () => {
  const { service } = createService(async () => candidates);

  const result = await service.previewHotelIntent(payload({
    selectionIntent: 'RATE_OPTION',
    rateOptionId: 'offline:211:540:3:2026-08-11:2026-08-12',
  }));

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].selectedRateOptionId, candidates[0].rateOptionId);
});

test('offline room-type preview uses room ID when a legacy room label is supplied', async () => {
  const { service } = createService(async () => candidates);

  const result = await service.previewHotelIntent(payload({
    selectionIntent: 'ROOM_TYPE',
    roomType: 'Jungle Deluxe',
    roomId: 540,
    // Simulates the legacy browser payload that did not yet carry roomTypeId.
    roomTypeId: undefined,
  }));

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map((selection: any) => selection.roomId), [540, 540]);
});

test('offline room-type preview accepts a constrained legacy room label alias', async () => {
  const legacyCandidates = candidates.map((candidate) => ({
    ...candidate,
    roomType: 'Jungle View Family',
    roomId: 1262,
  }));
  const { service } = createService(async () => legacyCandidates);

  const result = await service.previewHotelIntent(payload({
    selectionIntent: 'ROOM_TYPE',
    roomType: 'Jungle Family',
    roomId: undefined,
    roomTypeId: undefined,
  }));

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map((selection: any) => selection.roomType), ['Jungle View Family', 'Jungle View Family']);
});

test('preview from either night preserves the same continuous stay', async () => {
  const { service } = createService(async () => candidates);

  const dayOne = await service.previewHotelIntent(payload({ routeId: 10145, routeDate: '2026-08-12' }));
  const dayTwo = await service.previewHotelIntent(payload({ routeId: 10146, routeDate: '2026-08-13' }));

  assert.deepEqual(dayOne.affectedRouteIds, dayTwo.affectedRouteIds);
  assert.deepEqual(dayOne.logicalStay.stayDates, dayTwo.logicalStay.stayDates);
});

test('HOTEL intent does not pin a one-night card rate across a multi-night stay', async () => {
  const axisStay = {
    planId: 10124,
    provider: 'axisrooms',
    hotelCode: 'AX_DVI_HOTEL_232',
    hotelName: 'THE ARBOUR RESORT',
    checkInDate: '2026-08-22',
    checkOutDate: '2026-08-24',
    nights: 2,
    routeIds: [10719, 10720],
    stayDates: ['2026-08-22', '2026-08-23'],
    stayKey: 'axisrooms:AX_DVI_HOTEL_232:::2026-08-22_to_2026-08-24',
    anchorRouteId: 10720,
  };
  const axisCandidates = [
    {
      routeId: 10719,
      itineraryRouteId: 10719,
      date: '2026-08-22',
      provider: 'axisrooms',
      providerHotelCode: 'AX_DVI_HOTEL_232',
      hotelCode: '232',
      canonicalHotelId: 232,
      hotelId: 232,
      hotelName: 'THE ARBOUR RESORT',
      roomType: 'Room 607',
      mealPlan: 'CP',
      rateOptionId: 'axisrooms:232:607:CP_PLAN:2026-08-22',
      pricePerNight: 5000,
      totalPrice: 5000,
      isSelectable: true,
      isBookable: true,
    },
    {
      routeId: 10720,
      itineraryRouteId: 10720,
      date: '2026-08-23',
      provider: 'axisrooms',
      providerHotelCode: 'AX_DVI_HOTEL_232',
      hotelCode: '232',
      canonicalHotelId: 232,
      hotelId: 232,
      hotelName: 'THE ARBOUR RESORT',
      roomType: 'Room 606',
      mealPlan: 'CP',
      rateOptionId: 'axisrooms:232:606:CP_PLAN:2026-08-23',
      pricePerNight: 4500,
      totalPrice: 4500,
      isSelectable: true,
      isBookable: true,
    },
  ];
  const service = Object.create(ItinerariesService.prototype) as any;
  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI20260847', preferred_room_count: 1, total_adult: 2 }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-08-23T00:00:00.000Z') }),
    },
    dvi_global_settings: {
      findFirst: async () => ({ hotel_margin: 20, hotel_choose_rate_reuse_minutes: 7 }),
    },
    dvi_hotel: { findUnique: async () => ({
      hotel_id: 232, hotel_margin: 20, axisrooms_enabled: 1, axisrooms_property_id: 'AX_DVI_HOTEL_232',
    }) },
    dvi_hotel_occupancy_rate: {
      findMany: async ({ where }: any) => {
        assert.equal(where.hotel_id, 232);
        const date = where.start_date.lte.toISOString().slice(0, 10);
        const nightly = axisCandidates.find(candidate => candidate.date === date);
        assert.ok(nightly);
        assert.ok(nightly.rateOptionId.includes(`:${where.room_id}:`));
        return [{ rateplan_id: 'CP_PLAN', occupancy_rates: { DOUBLE: nightly.pricePerNight } }];
      },
    },
  };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => axisStay,
    previewStayExtension: async () => ({ canBookMultiNight: true, blocked: false }),
  };
  service.hotelDetailsTboService = {
    getSelectedHotelRates: async (_quoteId: string, routeId: number) => ({
      hotels: axisCandidates.filter((candidate) => candidate.routeId === routeId),
    }),
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => axisCandidates,
  };
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };

  const payload = {
    planId: 10124,
    routeId: 10720,
    groupType: 1,
    selectionIntent: 'HOTEL',
    provider: 'axisrooms',
    hotelCode: 'AX_DVI_HOTEL_232',
    providerHotelCode: 'AX_DVI_HOTEL_232',
    canonicalHotelId: 232,
    hotelName: 'THE ARBOUR RESORT',
    routeDate: '2026-08-23',
    previewOnly: true,
  };
  const result = await service.previewHotelIntent(payload);

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map((selection: any) => selection.routeDate), ['2026-08-22', '2026-08-23']);
  const remaining = Date.parse(result.checkedRateExpiresAt) - Date.now();
  assert.ok(remaining > 6.9 * 60_000 && remaining <= 7 * 60_000);
  assert.deepEqual(result.selections.map((selection: any) => selection.roomType), ['Room 607', 'Room 606']);
  assert.deepEqual(result.selections.map((selection: any) => selection.pricePerNight), [6000, 5400]);
  assert.deepEqual(result.selections.map((selection: any) => selection.hotelMarginPercentage), [20, 20]);
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
    pricePerNight: 2340,
    totalPrice: 2340,
    isSelectable: true,
    isBookable: true,
  }));

  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082', preferred_room_count: 3 }),
    },
    dvi_global_settings: {
      findFirst: async () => ({ hotel_margin: 20 }),
    },
    dvi_hotel: {
      findUnique: async () => ({
        hotel_id: 44596,
        staah_enabled: 1,
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
    getSelectedHotelRates: async (_quoteId: string, routeId: number, provider: string, hotelCode: string) => {
      assert.equal(provider, 'staah');
      refreshedCodes.push(hotelCode);
      return { hotels: staahCandidates.filter(candidate => candidate.routeId === routeId) };
    },
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => { throw new Error('STAAH preview must use the fresh provider result'); },
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
  assert.deepEqual(result.selections.map((selection: any) => selection.pricePerNight), [2808, 2808]);
  assert.deepEqual(result.selections.map((selection: any) => selection.totalPrice), [8424, 8424]);
  assert.equal(result.selections[0].amountIncludesHotelMargin, true);
  assert.equal(result.selections[0].pricingIncludesHotelMargin, true);
});

test('STAAH ROOM_TYPE preview keeps nested Suite identity instead of inheriting parent Deluxe identity', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  const staahRows = stay.routeIds.map((routeId, index) => ({
    routeId,
    itineraryRouteId: routeId,
    date: stay.stayDates[index],
    provider: 'staah',
    canonicalHotelId: 44596,
    hotelId: 44596,
    hotelCode: 'STAAHTESTHOTELPROD',
    providerHotelCode: 'STAAHTESTHOTELPROD',
    hotelName: 'STAAH TEST HOTEL PROD',
    roomType: 'Deluxe Room',
    mealPlan: 'CP',
    rateOptionId: `staah|44596|deluxeroom|cp_plan|||continental plan|${stay.stayDates[index]}|2026-08-14`,
    optionKey: `staah|44596|deluxeroom|cp_plan|||continental plan|${stay.stayDates[index]}|2026-08-14`,
    rateOptions: [
      {
        roomType: 'Deluxe Room',
        mealPlan: 'CP',
        rateId: 'CP_PLAN',
        searchReference: `DELUXE-${index}`,
        pricePerNight: 2347.2,
      },
      {
        roomType: 'Suite Room',
        mealPlan: 'MAP',
        roomId: 'SUITEROOM',
        rateId: 'MAP_PLAN',
        searchReference: `SUITE-${index}`,
        pricePerNight: 1956,
      },
    ],
  }));

  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082' }),
    },
    dvi_hotel: {
      findUnique: async () => ({
        hotel_id: 44596,
        staah_enabled: 1,
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
    getSelectedHotelRates: async (_quoteId: string, routeId: number, provider: string, hotelCode: string) => {
      assert.equal(provider, 'staah');
      assert.equal(hotelCode, 'STAAHTESTHOTELPROD');
      return { hotels: staahRows.filter(candidate => candidate.routeId === routeId) };
    },
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => { throw new Error('STAAH preview must use the fresh provider result'); },
  };

  const result = await service.previewHotelIntent({
    planId: 10040,
    routeId: 10145,
    groupType: 1,
    selectionIntent: 'ROOM_TYPE',
    provider: 'staah',
    providerHotelCode: 'STAAHTESTHOTELPROD',
    hotelCode: 'STAAHTESTHOTELPROD',
    canonicalHotelId: 44596,
    hotelId: 44596,
    hotelName: 'STAAH TEST HOTEL PROD',
    roomType: 'Suite Room',
    routeDate: '2026-08-12',
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map((selection: any) => selection.roomType), ['Suite Room', 'Suite Room']);
  assert.deepEqual(result.selections.map((selection: any) => selection.mealPlan), ['MAP', 'MAP']);
  assert.ok(result.selections.every((selection: any) => selection.selectedRateOptionId.includes('SUITE')));
  assert.ok(result.selections.every((selection: any) => !selection.selectedRateOptionId.includes('DELUXE')));
});

test('TBO RATE_OPTION preview keeps the commercial room when its session token and room IDs rotate', async () => {
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
    roomId: 22,
    roomTypeId: 22,
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
    searchSelectedHotelForContinuousStay: async (params: any) => {
      assert.deepEqual(params.routeIds, [10145]);
      assert.equal(params.checkInDate, '2026-08-12');
      assert.equal(params.checkOutDate, '2026-08-13');
      assert.equal(params.provider, 'tbo');
      assert.equal(params.hotelCode, '1313362');
      return [freshCandidate];
    },
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
    roomId: 11,
    roomTypeId: 11,
    roomType: 'Garden Suite',
    mealPlanCode: 'MAP',
    routeDate: '2026-08-12',
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].selectionKey, selectionKey);
  assert.equal(result.selections[0].selectedRateOptionId, freshBookingCode);
  assert.equal(result.selections[0].supplierBookingCode, freshBookingCode);
});

test('TBO preview does not multiply an occupancy fare by room count twice', async () => {
  const service = Object.create(ItinerariesService.prototype) as any;
  const checkedAt = Date.now();
  const tboStay = {
    routeIds: [10145],
    stayDates: ['2026-08-12'],
    nights: 1,
    checkInDate: '2026-08-12',
    checkOutDate: '2026-08-13',
    stayKey: 'tbo:1313362:2026-08-12_to_2026-08-13',
  };
  const occupancyFare = {
    routeId: 10145,
    itineraryRouteId: 10145,
    date: '2026-08-12',
    provider: 'tbo',
    hotelCode: '1313362',
    providerHotelCode: '1313362',
    hotelName: 'SAGARA BEACH RESORT',
    roomType: 'Standard Non Sea View',
    mealPlan: 'MAP',
    rateOptionId: 'sagara-map',
    optionKey: 'sagara-map',
    expiresAt: new Date(checkedAt + 15 * 60_000),
    supplierSessionExpiresAt: new Date(checkedAt + 35 * 60_000).toISOString(),
    supplierSearchCompletedAt: new Date(checkedAt).toISOString(),
    roomCount: 4,
    pricePerNight: 26129,
    totalPrice: 26129,
    hotelMarginPercentage: 5,
    isSelectable: true,
    isBookable: true,
  };

  service.prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({ itinerary_quote_ID: 'DVI2026082', preferred_room_count: 4 }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_date: new Date('2026-08-12T00:00:00.000Z') }),
    },
    dvi_global_settings: {
      findFirst: async () => ({ hotel_margin: 5, hotel_choose_rate_reuse_minutes: 30 }),
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
    searchSelectedHotelForContinuousStay: async () => [occupancyFare],
    getSelectedHotelRates: async () => ({ hotels: [occupancyFare] }),
  };
  service.hotelAvailabilitySnapshotService = {
    mergeSelectedHotelRates: async () => undefined,
    getActiveRows: async () => [occupancyFare],
  };

  const request = {
    planId: 10040,
    routeId: 10145,
    groupType: 1,
    selectionIntent: 'HOTEL',
    provider: 'tbo',
    hotelCode: '1313362',
    providerHotelCode: '1313362',
    hotelName: 'SAGARA BEACH RESORT',
    routeDate: '2026-08-12',
    previewOnly: true,
  };
  const result = await service.previewHotelIntent(request);

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.selections[0].pricePerNight, 27435.45);
  assert.equal(result.selections[0].totalPrice, 27435.45);
  assert.equal(result.checkedRateSearchedAt, occupancyFare.supplierSearchCompletedAt);
  assert.equal(Date.parse(result.checkedRateExpiresAt), checkedAt + 30 * 60_000);

  occupancyFare.supplierSessionExpiresAt = new Date(checkedAt + 8 * 60_000).toISOString();
  const shorter = await service.previewHotelIntent(request);
  assert.equal(shorter.checkedRateExpiresAt, occupancyFare.supplierSessionExpiresAt);
});

test('offline confirm returns DB-verified identity even when request name is contradictory', async () => {
  const { service, cancelledHolds } = createService(async () => candidates);

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
  assert.deepEqual(cancelledHolds, [{
    itineraryPlanId: 10040, groupType: 1, routeIds: stay.routeIds,
    actor: { id: undefined, type: 'STAFF' },
  }]);
});

test('offline failed persistence never cancels existing holds', async () => {
  const { service, cancelledHolds } = createService(async () => candidates);
  service.selectionWorkflowService.bulkSaveHotels = async () => { throw new Error('transaction rolled back'); };
  await assert.rejects(
    () => service.selectHotelIntent(payload()),
    (error: any) => error.response?.code === 'HOTEL_INTENT_PERSIST_FAILED',
  );
  assert.deepEqual(cancelledHolds, []);
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
  const { service, persistedPayloads, cancelledHolds } = createService(async () => spriseCandidates);
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
  assert.equal(cancelledHolds.length, 1);
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

test('TBO HOTEL intent prices each continuous-stay route from its room-night breakdown', async () => {
  const tboStay = {
    routeIds: [20101, 20102],
    stayDates: ['2026-09-03', '2026-09-04'],
    nights: 2,
    checkInDate: '2026-09-03',
    checkOutDate: '2026-09-05',
    stayKey: 'tbo:1130403:2026-09-03_to_2026-09-05',
  };
  const roomNightBreakdown = [
    { roomNumber: 1, date: '2026-09-03', adults: 3, children: 0, childrenAges: [], allInAmount: 15379.64, nightTotal: 28895.73 },
    { roomNumber: 2, date: '2026-09-03', adults: 2, children: 0, childrenAges: [], allInAmount: 13516.09, nightTotal: 28895.73 },
    { roomNumber: 1, date: '2026-09-04', adults: 3, children: 0, childrenAges: [], allInAmount: 15824.94, nightTotal: 29774.38 },
    { roomNumber: 2, date: '2026-09-04', adults: 2, children: 0, childrenAges: [], allInAmount: 13949.44, nightTotal: 29774.38 },
  ];
  const tboCandidates = [
    { routeId: 20101, itineraryRouteId: 20101, date: '2026-09-03', provider: 'tbo', hotelCode: '1130403', providerHotelCode: '1130403', hotelName: 'ELA', roomType: 'Deluxe Room', mealPlan: 'CP', pricePerNight: 30801.81, totalPrice: 30801.81, roomCount: 2, hotelMarginPercentage: 5, tboRoomNightBreakdown: roomNightBreakdown, isSelectable: true, isBookable: true },
    { routeId: 20102, itineraryRouteId: 20102, date: '2026-09-04', provider: 'tbo', hotelCode: '1130403', providerHotelCode: '1130403', hotelName: 'ELA', roomType: 'Deluxe Room', mealPlan: 'CP', pricePerNight: 30801.81, totalPrice: 30801.81, roomCount: 2, hotelMarginPercentage: 5, tboRoomNightBreakdown: roomNightBreakdown, isSelectable: true, isBookable: true },
    { routeId: 20102, itineraryRouteId: 20102, date: '2026-09-04', provider: 'tbo', hotelCode: '1130403', providerHotelCode: '1130403', hotelName: 'ELA', roomType: 'Suite Room', mealPlan: 'CP', pricePerNight: 90, totalPrice: 90, isSelectable: true, isBookable: true },
  ];
  const service = Object.create(ItinerariesService.prototype) as any;
  service.prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: 'DVI20260920', preferred_room_count: 1 }) },
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_date: new Date('2026-09-03T00:00:00.000Z') }) },
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 10 }) },
  };
  service.hotelStayBlockValidationService = {
    buildContinuousStayCandidate: async () => tboStay,
    previewStayExtension: async () => ({ canBookMultiNight: true, blocked: false }),
  };
  service.hotelDetailsTboService = {
    searchSelectedHotelForContinuousStay: async () => [tboCandidates[0]],
    getSelectedHotelRates: async (_quoteId: string, routeId: number) => ({
      hotels: tboCandidates.filter((candidate) => candidate.routeId === routeId),
    }),
  };
  service.selectionWorkflowService = {
    withHotelSelectionLock: async (_planId: number, _groupType: number, callback: () => Promise<any>) => callback(),
  };
  service.hotelAvailabilitySnapshotService = { getActiveRows: async () => tboCandidates };

  const result = await service.previewHotelIntent({
    planId: 10321,
    routeId: 20101,
    groupType: 1,
    selectionIntent: 'HOTEL',
    provider: 'vsr',
    providerHotelCode: '1130403',
    hotelCode: '1130403',
    hotelName: 'ELA',
    roomType: 'Deluxe Room',
    mealPlanCode: 'CP',
    routeDate: '2026-09-03',
    hotelMarginPercentage: 10,
  });

  assert.equal(result.status, 'AVAILABLE');
  assert.deepEqual(result.selections.map((selection: any) => selection.roomType), ['Deluxe Room', 'Deluxe Room']);
  assert.deepEqual(result.selections.map((selection: any) => selection.baseTotalPrice), [28895.73, 29774.38]);
  assert.deepEqual(result.selections.map((selection: any) => selection.hotelMarginAmount), [1444.79, 1488.72]);
  assert.deepEqual(result.selections.map((selection: any) => selection.pricePerNight), [30340.52, 31263.10]);
  assert.equal(Math.round(result.selections.reduce((sum: number, selection: any) => sum + selection.totalPrice, 0) * 100) / 100, 61603.62);
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

test('TBO persisted identity prefers the supplier master over a legacy snapshot fallback', () => {
  const identity = resolvePersistedHotelIdentity({
    hotel_id: null,
    hotel_code: '6347537',
    hotel_provider: 'tbo',
    selected_price_snapshot: JSON.stringify({
      provider: 'tbo',
      providerHotelCode: '6347537',
      hotelName: 'Hotel 6347537',
      category: null,
    }),
  }, null, {
    tbo_hotel_code: '6347537',
    hotel_name: 'Hill Crest Resort Coorg',
    star_rating: 4,
  });

  assert.equal(identity.hotelName, 'Hill Crest Resort Coorg');
  assert.equal(identity.category, 4);
});

test('TBO persisted identity retains the legacy snapshot when the supplier master is unavailable', () => {
  const identity = resolvePersistedHotelIdentity({
    hotel_code: 'missing-code',
    hotel_provider: 'tbo',
    selected_price_snapshot: JSON.stringify({
      provider: 'tbo',
      hotelName: 'Legacy TBO Hotel',
      category: '3-Star',
    }),
  }, null, null);

  assert.equal(identity.hotelName, 'Legacy TBO Hotel');
  assert.equal(identity.category, 3);
});
