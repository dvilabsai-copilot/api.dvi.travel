import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHotelCardQuote } from '../src/modules/itineraries/utils/hotel-card-quote.util';
import { HotelAvailabilitySnapshotService } from '../src/modules/itineraries/services/hotel-availability-snapshot.service';

const lake = {
  provider: 'tbo', hotelCode: '1512622', itineraryRouteId: 26404, date: '2026-12-06',
  pricePerNight: 819.68, totalPrice: 1639.36, numberOfNights: 4,
  amountIncludesHotelMargin: true,
  tboRoomNightBreakdown: [
    { roomNumber: 1, date: '2026-12-06', allInAmount: 3122.59, nightTotal: 3122.59 },
    { roomNumber: 1, date: '2026-12-07', allInAmount: 3122.58, nightTotal: 3122.58 },
  ],
};

test('corrupted cached Lake option uses the supplier date lines, without mutation', () => {
  const before = JSON.stringify(lake);
  assert.equal(buildHotelCardQuote(lake, 5, 1)?.payableAmount, 3278.72);
  assert.equal(buildHotelCardQuote({ ...lake, date: '2026-12-07', itineraryRouteId: 26405 }, 5, 1)?.payableAmount, 3278.71);
  assert.equal(JSON.stringify(lake), before);
});

test('two-room supplier quote adds room lines once and allocates margin across unequal nights', () => {
  const row = { ...lake, tboRoomNightBreakdown: [
    { roomNumber: 1, date: '2026-12-06', allInAmount: 1000.01, nightTotal: 3000.03 },
    { roomNumber: 2, date: '2026-12-06', allInAmount: 2000.02, nightTotal: 3000.03 },
    { roomNumber: 1, date: '2026-12-07', allInAmount: 1500, nightTotal: 3500 },
    { roomNumber: 2, date: '2026-12-07', allInAmount: 2000, nightTotal: 3500 },
  ] };
  const a = buildHotelCardQuote(row, 5, 2)!;
  const b = buildHotelCardQuote({ ...row, date: '2026-12-07' }, 5, 2)!;
  assert.equal(Math.round(a.payableAmount * 100) + Math.round(b.payableAmount * 100), 682503);
  assert.equal(a.roomCount, 2);
});

test('invalid/missing dates, incomplete occupancy, inconsistent supplier lines never produce estimates', () => {
  assert.equal(buildHotelCardQuote({ ...lake, date: '2026-12-08' }, 5, 1), null);
  assert.equal(buildHotelCardQuote(lake, 5, 2), null);
  assert.equal(buildHotelCardQuote({ ...lake, date: '' }, 5, 1), null);
  assert.equal(buildHotelCardQuote({ ...lake, tboRoomNightBreakdown: [{ date: lake.date, roomNumber: 1, allInAmount: -1 }] }, 5, 1), null);
  assert.equal(buildHotelCardQuote({ ...lake, tboRoomNightBreakdown: undefined, pricePerNight: undefined, totalPrice: 6000 }, 5, 1), null);
});

test('AX route price includes property margin, occupancy supplements and tax once', () => {
  const row = { provider: 'axisrooms', itineraryRouteId: 26404, date: lake.date,
    basePricePerNight: 3500, baseTotalPrice: 3500, pricePerNight: 3500, totalPrice: 3500 };
  assert.equal(buildHotelCardQuote(row, 7, 1)?.payableAmount, 3745);
  assert.equal(buildHotelCardQuote({ ...row, totalRoomCost: 7000, baseTotalPrice: 7000,
    extraBedCount: 1, extraBedRate: 1000, totalHotelTaxAmount: 100 }, 7, 2)?.payableAmount, 8660);
});

test('offline nightly components and already projected quotes do not double hotel margin', () => {
  const row = { provider: 'offline', itineraryRouteId: 26404, date: lake.date,
    basePricePerNight: 3500, baseTotalPrice: 3500, pricePerNight: 3745, totalPrice: 3745,
    amountIncludesHotelMargin: true, hotelMarginPercentage: 7 };
  assert.equal(buildHotelCardQuote(row, 7, 1)?.payableAmount, 3745);
  assert.equal(buildHotelCardQuote({ ...row, numberOfNights: 2, nightlyRates: [
    { date: lake.date, baseAmount: 3500 }, { date: '2026-12-07', baseAmount: 4000 },
  ] }, 7, 1)?.payableAmount, 3745);
});

test('cached DTO projection uses AX master margin and global TBO margin, preserving order and prices', async () => {
  const service = new HotelAvailabilitySnapshotService({
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 5 }) },
    dvi_hotel: { findMany: async () => [{ hotel_id: 95, hotel_margin: 7 }] },
  } as any, {} as any, {} as any, {} as any);
  const rows = [lake, { provider: 'axisrooms', hotelId: 95, canonicalHotelId: 95,
    itineraryRouteId: 26404, date: lake.date, pricePerNight: 3500, basePricePerNight: 3500,
    totalPrice: 3500, rateOptions: [{ pricePerNight: 3500, basePricePerNight: 3500, totalPrice: 3500 }] }];
  const before = JSON.stringify(rows);
  const result = await (service as any).attachCardQuotes(rows, { preferred_room_count: 1 });
  assert.deepEqual(result.map((row: any) => row.provider), ['tbo', 'axisrooms']);
  assert.equal(result[0].cardQuote.payableAmount, 3278.72);
  assert.equal(result[1].cardQuote.payableAmount, 3745);
  assert.equal(result[1].rateOptions[0].cardQuote.payableAmount, 3745);
  assert.equal(JSON.stringify(rows), before);
});

test('paged persisted response quotes cached nested rates without live search or financial writes', async () => {
  let writes = 0;
  const prisma = {
    dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_plan_ID: 12181, preferred_room_count: 1 }) },
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 5, show_ep_hotels: 1 }) },
    dvi_itinerary_plan_hotel_details: { findMany: async () => [], update: async () => { writes++; } },
    dvi_itinerary_hotel_search_cache: { findMany: async () => [{
      full_payload: JSON.stringify({ ...lake, groupType: 0, roomType: 'Cinnamon Room', mealPlan: 'CP',
        rateOptions: [{ ...lake, roomType: 'Cinnamon Room', mealPlan: 'CP', rateOptionId: 'lake-rate' }] }),
    }] },
  };
  const service = new HotelAvailabilitySnapshotService(prisma as any, {
    getHotelDetailsByQuoteIdFromTbo: async () => { throw Error('read must not search'); },
  } as any, {} as any, {} as any);
  const response = await service.readPersisted('DVI20261117', { page: 1, pageSize: 20, groupType: 2, itineraryRouteId: 26404 }, async () => ({
    quoteId: 'DVI20261117', planId: 12181, hotels: [], hotelTabs: [], totalRoomCount: 1,
  } as any));
  assert.equal((response.hotels[0] as any).rateOptions[0].cardQuote.payableAmount, 3278.72);
  assert.equal((response.hotels[0] as any).rateOptions[0].pricePerNight, 819.68);
  assert.equal(writes, 0);
});

test('a different nested room cannot inherit the default room supplier breakdown', async () => {
  const service = new HotelAvailabilitySnapshotService({
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 5 }) },
  } as any, {} as any, {} as any, {} as any);
  const result = await (service as any).attachCardQuotes([{ ...lake, rateOptions: [{
    provider: 'tbo', roomType: 'Suite', pricePerNight: 4000, basePricePerNight: 4000,
  }] }], { preferred_room_count: 1 });
  assert.equal(result[0].rateOptions[0].cardQuote.payableAmount, 4200);
});

test('compact persisted selections retain the exact saved nightly quote in every group', async () => {
  const service = new HotelAvailabilitySnapshotService({
    dvi_itinerary_plan_details: { findFirst: async () => ({ itinerary_plan_ID: 12181, preferred_room_count: 1, no_of_nights: 1 }) },
    dvi_itinerary_route_details: { findMany: async () => [{ itinerary_route_ID: 26404, itinerary_route_date: '2026-12-06', next_visiting_location: 'Munnar' }] },
    dvi_itinerary_plan_hotel_details: { findMany: async () => [] },
  } as any, {} as any, {} as any, {} as any);
  const input = {
    quoteId: 'DVI20261117', planId: 12181, hotelTabs: [{ groupType: 1, label: 'Recommended #1', totalAmount: 3278.72 }], totalRoomCount: 1,
    hotels: [{ groupType: 1, itineraryRouteId: 26404, date: '2026-12-06',
      provider: 'tbo', hotelName: 'Lake N Hills Resorts', hotelCode: '1512622',
      roomType: 'Cinnamon Room', mealPlan: 'CP', rateOptionId: 'lake-rate',
      isSelected: true, selectionId: 61859, selectionOrigin: 'USER_SELECTED',
      pricePerNight: 3278.72, totalHotelCost: 3278.72, numberOfNights: 4 }],
  };
  const result = await service.readPersisted('DVI20261117', { pageSize: 0 }, async () => input as any);
  assert.equal((result.hotels[0] as any).cardQuote.payableAmount, 3278.72);
  assert.equal((result as any).hotelSelectionState[0].routes[0].selected.cardQuote.payableAmount, 3278.72);
});
