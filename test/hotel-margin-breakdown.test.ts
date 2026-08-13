import assert from 'node:assert/strict';
import test from 'node:test';
import { HotelPricingService } from '../src/modules/itineraries/hotels/hotel-pricing.service';
import { OfflineHotelCatalogService } from '../src/modules/itineraries/services/offline-hotel-catalog.service';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';

test('effective margin precedence is hotel, global DB, then environment', async () => {
  let globalReads = 0;
  const prisma = {
    dvi_global_settings: {
      findFirst: async () => {
        globalReads += 1;
        return { hotel_margin: 20 };
      },
    },
  } as any;
  const pricing = new HotelPricingService(prisma);

  assert.equal(await pricing.resolveEffectiveHotelMarginPercentage({ hotel_margin: 12 }), 12);
  assert.equal(globalReads, 0);
  assert.equal(await pricing.resolveEffectiveHotelMarginPercentage({ hotel_margin: 0 }), 20);

  const previous = process.env.HOTEL_MARGIN;
  process.env.HOTEL_MARGIN = '10';
  const environmentPricing = new HotelPricingService({
    dvi_global_settings: { findFirst: async () => null },
  } as any);
  assert.equal(await environmentPricing.resolveEffectiveHotelMarginPercentage({ hotel_margin: 0 }), 10);
  process.env.HOTEL_MARGIN = previous;
});

test('offline two-night pricing exposes one coherent 20 percent breakdown', async () => {
  const prisma = {
    dvi_global_settings: { findFirst: async () => ({ hotel_margin: 20 }) },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 1, total_adult: 2, total_children: 0 }) },
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_ID: 10, itinerary_route_date: new Date('2099-01-02') }) },
    dvi_hotel: { findFirst: async () => ({ hotel_id: 436, hotel_name: 'BLOSSOM HILL RESORT', hotel_category: 3, hotel_margin: 0 }) },
    dvi_hotel_rooms: { findMany: async () => [{ room_ID: 1251, room_type_id: 612, room_title: 'Cottage', breakfast_included: 1 }] },
    dvi_hotel_room_price_book: { findMany: async () => [{ room_type_id: 612, year: '2099', month: 'January', day_1: 2600, day_2: 2600 }] },
  } as any;
  const service = new OfflineHotelCatalogService(prisma, new HotelPricingService(prisma));

  const rate = await service.resolveOfflineRateOption({
    planId: 1,
    routeId: 10,
    canonicalHotelId: 436,
    rateOptionId: 'offline:436:1251:612:2099-01-01:2099-01-03',
    roomCount: 1,
  });

  assert.equal(rate.hotelMarginPercentage, 20);
  assert.equal(rate.baseTotalPrice, 5200);
  assert.equal(rate.hotelMarginTotalAmount, 1040);
  assert.equal(rate.totalStayPrice, 6240);
  assert.deepEqual(rate.nightlyRates.map((night) => ({
    base: night.baseAmount,
    margin: night.marginAmount,
    sell: night.sellAmount,
  })), [
    { base: 2600, margin: 520, sell: 3120 },
    { base: 2600, margin: 520, sell: 3120 },
  ]);
});

test('offline persistence stores one route night and retains explicit stay totals', async () => {
  let hotelWrite: any;
  let roomWrite: any;
  const prisma: any = {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ itinerary_plan_hotel_details_ID: 9, hotel_approval_status: 'NOT_REQUESTED', manual_confirmation_status: 'NOT_STARTED' }],
      update: async ({ data }: any) => { hotelWrite = data; return { itinerary_plan_hotel_details_ID: 9 }; },
    },
    dvi_itinerary_plan_hotel_room_details: {
      findFirst: async () => ({ itinerary_plan_hotel_room_details_ID: 10 }),
      update: async ({ data }: any) => { roomWrite = data; },
    },
    dvi_itinerary_plan_hotel_approval_history: { create: async () => undefined },
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_quote_ID: '' }) },
    $transaction: async (callback: any) => callback(prisma),
  };
  const offlineCatalog = {
    resolveOfflineRateOption: async () => ({
      provider: 'offline', canonicalHotelId: 436, routeId: 10, routeDate: '2099-01-02',
      rateOptionId: 'offline:436:1251:612:2099-01-01:2099-01-03', roomId: 1251, roomTypeId: 612,
      roomCount: 2,
      pricePerNight: 3120, basePricePerNight: 2600, baseTotalPrice: 5200,
      hotelMarginPercentage: 20, hotelMarginAmount: 520, hotelMarginTotalAmount: 1040,
      totalStayPrice: 6240, numberOfNights: 2, currency: 'INR',
      nightlyRates: [
        { date: '2099-01-01', baseAmount: 2600, marginPercentage: 20, marginAmount: 520, sellAmount: 3120 },
        { date: '2099-01-02', baseAmount: 2600, marginPercentage: 20, marginAmount: 520, sellAmount: 3120 },
      ],
    }),
  } as any;
  const service = new ItinerarySelectionWorkflowService(
    prisma, null as any, null as any, { clearCacheForQuote: () => undefined } as any, offlineCatalog,
  );

  await service.selectHotel({
    planId: 1, routeId: 10, hotelId: 436, canonicalHotelId: 436,
    roomTypeId: 612, groupType: 1, provider: 'offline',
    rateOptionId: 'offline:436:1251:612:2099-01-01:2099-01-03', roomCount: 1,
  });

  assert.equal(hotelWrite.total_room_cost, 2600);
  assert.equal(hotelWrite.hotel_margin_percentage, 20);
  assert.equal(hotelWrite.hotel_margin_rate, 520);
  assert.equal(hotelWrite.selected_total_price, 3120);
  assert.equal(hotelWrite.total_hotel_cost, 3120);
  assert.equal(hotelWrite.total_no_of_rooms, 2);
  assert.equal(roomWrite.room_qty, 2);
  assert.equal(roomWrite.total_room_cost, 3120);
  const snapshot = JSON.parse(hotelWrite.selected_price_snapshot);
  assert.equal(snapshot.pricingScope, 'ROUTE_NIGHT');
  assert.equal(snapshot.baseTotalPrice, 2600);
  assert.equal(snapshot.hotelMarginTotalAmount, 520);
  assert.equal(snapshot.totalPrice, 3120);
  assert.equal(snapshot.stayTotalPrice, 6240);
});
