import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { HotelSearchService } from '../src/modules/hotels/services/hotel-search.service';
import { ItineraryHotelApprovalService } from '../src/modules/itineraries/services/itinerary-hotel-approval.service';
import { OfflineHotelCatalogService } from '../src/modules/itineraries/services/offline-hotel-catalog.service';
import { ItineraryConfirmationService } from '../src/modules/itineraries/services/itinerary-confirmation.service';

test('axis-only search never invokes registered forbidden suppliers and rejects conflicting flags', async () => {
  const calls = { tbo: 0, resavenue: 0, hobse: 0 };
  const provider = (name: string) => ({
    getName: () => name,
    search: async () => { calls[name as keyof typeof calls] += 1; return []; },
  });
  const prisma = {
    dvi_hotel: { findMany: async () => [] },
  } as any;
  const offline = { searchOfflineHotels: async () => [] } as any;
  const service = new HotelSearchService(prisma, provider('tbo') as any, provider('resavenue') as any, provider('hobse') as any, offline);
  const previousAxis = process.env.HOTEL_FETCH_AXIS_ONLY;
  const previousTbo = process.env.HOTEL_FETCH_TBO_ONLY;
  process.env.HOTEL_FETCH_AXIS_ONLY = 'true';
  process.env.HOTEL_FETCH_TBO_ONLY = 'false';
  await service.searchHotels({ cityCode: 'Munnar', checkInDate: '2099-01-01', checkOutDate: '2099-01-02', roomCount: 1, guestCount: 2 } as any);
  assert.deepEqual(calls, { tbo: 0, resavenue: 0, hobse: 0 });
  process.env.HOTEL_FETCH_TBO_ONLY = 'true';
  await assert.rejects(() => service.searchHotels({ cityCode: 'Munnar', checkInDate: '2099-01-01', checkOutDate: '2099-01-02', roomCount: 1, guestCount: 2 } as any), /cannot both be enabled/);
  process.env.HOTEL_FETCH_AXIS_ONLY = previousAxis;
  process.env.HOTEL_FETCH_TBO_ONLY = previousTbo;
});

test('offline option is priced from every requested night and missing nights are rejected', async () => {
  const prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 1 }) },
    // The route may be any night in the continuous stay represented by the
    // rate option, not only the first night.
    dvi_itinerary_route_details: { findFirst: async () => ({ itinerary_route_ID: 10, itinerary_route_date: new Date('2099-01-02') }) },
    dvi_hotel: { findFirst: async () => ({ hotel_id: 153, hotel_name: 'GREENRIDGE', hotel_category: 2, hotel_margin: 0, hotel_margin_gst_type: 0, hotel_margin_gst_percentage: 0 }) },
    dvi_hotel_rooms: { findMany: async () => [{ room_ID: 22, room_type_id: 7, room_title: 'Deluxe', room_ref_code: 'D', breakfast_included: 1, lunch_included: 0, dinner_included: 0 }] },
    dvi_hotel_room_price_book: { findMany: async () => [{ room_type_id: 7, price_type: 0, year: '2099', month: 'January', day_1: '4500', day_2: '4500' }] },
  } as any;
  const pricing = {
    resolveEffectiveHotelMarginPercentage: async () => 0,
    marginBreakdown: (value: number) => ({ baseAmount: value, marginPercentage: 0, marginAmount: 0, sellAmount: value }),
    money: (value: number) => Number(value.toFixed(2)),
  } as any;
  const service = new OfflineHotelCatalogService(prisma, pricing);
  const resolved = await service.resolveOfflineRateOption({ planId: 1, routeId: 10, canonicalHotelId: 153, rateOptionId: 'offline:153:22:7:2099-01-01:2099-01-03', roomCount: 1 });
  assert.equal(resolved.pricePerNight, 4500);
  assert.equal(resolved.routeId, 10);
  assert.equal(resolved.totalStayPrice, 9000);
  assert.equal(resolved.nightlyRates.length, 2);
  assert.deepEqual({
    provider: resolved.provider,
    hotelId: resolved.hotelId,
    canonicalHotelId: resolved.canonicalHotelId,
    hotelCode: resolved.hotelCode,
    providerHotelCode: resolved.providerHotelCode,
    hotelName: resolved.hotelName,
    category: resolved.category,
  }, {
    provider: 'offline',
    hotelId: 153,
    canonicalHotelId: 153,
    hotelCode: '153',
    providerHotelCode: '153',
    hotelName: 'GREENRIDGE',
    category: 2,
  });
  prisma.dvi_hotel_room_price_book.findMany = async () => [{ room_type_id: 7, price_type: 0, year: '2099', month: 'January', day_1: '4500' }];
  await assert.rejects(() => service.resolveOfflineRateOption({ planId: 1, routeId: 10, canonicalHotelId: 153, rateOptionId: 'offline:153:22:7:2099-01-01:2099-01-03', roomCount: 1 }), /no longer priced/);
});

test('offline option uses the itinerary room count when the request omits or understates it', async () => {
  const prisma = {
    dvi_itinerary_plan_details: {
      findUnique: async () => ({
        itinerary_plan_ID: 1,
        preferred_room_count: 2,
        total_adult: 4,
        total_children: 0,
      }),
    },
    dvi_itinerary_route_details: {
      findFirst: async () => ({ itinerary_route_ID: 10, itinerary_route_date: new Date('2099-01-01') }),
    },
    dvi_hotel: {
      findFirst: async () => ({
        hotel_id: 153,
        hotel_name: 'GREENRIDGE',
        hotel_category: 2,
        hotel_margin: 0,
        hotel_margin_gst_type: 0,
        hotel_margin_gst_percentage: 0,
      }),
    },
    dvi_hotel_rooms: {
      findMany: async () => [{
        room_ID: 22,
        room_type_id: 7,
        room_title: 'Deluxe',
        room_ref_code: 'D',
        total_max_adults: 3,
        total_max_childrens: 2,
        breakfast_included: 1,
        lunch_included: 0,
        dinner_included: 0,
      }],
    },
    dvi_hotel_room_price_book: {
      findMany: async () => [{
        room_type_id: 7,
        price_type: 0,
        year: '2099',
        month: 'January',
        day_1: 4500,
        day_2: 4500,
      }],
    },
  } as any;
  const pricing = {
    resolveEffectiveHotelMarginPercentage: async () => 0,
    marginBreakdown: (value: number) => ({ baseAmount: value, marginPercentage: 0, marginAmount: 0, sellAmount: value }),
    money: (value: number) => Number(value.toFixed(2)),
  } as any;
  const service = new OfflineHotelCatalogService(prisma, pricing);

  const resolved = await service.resolveOfflineRateOption({
    planId: 1,
    routeId: 10,
    canonicalHotelId: 153,
    rateOptionId: 'offline:153:22:7:2099-01-01:2099-01-03',
    // Simulate a stale client value. The plan's two-room requirement must win.
    roomCount: 1,
  });

  assert.equal(resolved.roomType, 'Deluxe');
  assert.equal(resolved.roomCount, 2);
  assert.equal(resolved.pricePerNight, 9000);
  assert.equal(resolved.totalStayPrice, 18000);
  assert.deepEqual(resolved.nightlyRates.map((night) => night.sellAmount), [9000, 9000]);
});

test('offline selection reconciles a stale route id using the selected route date', async () => {
  const calls: any[] = [];
  const prisma = {
    dvi_itinerary_plan_details: { findUnique: async () => ({ itinerary_plan_ID: 1 }) },
    dvi_itinerary_route_details: {
      findFirst: async ({ where }: any) => {
        calls.push(where);
        if (where.itinerary_route_ID === 999) return null;
        return { itinerary_route_ID: 10, itinerary_route_date: new Date('2099-01-02') };
      },
    },
    dvi_hotel: { findFirst: async () => ({ hotel_id: 153, hotel_name: 'GREENRIDGE', hotel_category: 2, hotel_margin: 0, hotel_margin_gst_type: 0, hotel_margin_gst_percentage: 0 }) },
    dvi_hotel_rooms: { findMany: async () => [{ room_ID: 22, room_type_id: 7, room_title: 'Deluxe', room_ref_code: 'D', breakfast_included: 1, lunch_included: 0, dinner_included: 0 }] },
    dvi_hotel_room_price_book: { findMany: async () => [{ room_type_id: 7, price_type: 0, year: '2099', month: 'January', day_1: '4500', day_2: '4500' }] },
  } as any;
  const pricing = {
    resolveEffectiveHotelMarginPercentage: async () => 0,
    marginBreakdown: (value: number) => ({ baseAmount: value, marginPercentage: 0, marginAmount: 0, sellAmount: value }),
    money: (value: number) => Number(value.toFixed(2)),
  } as any;
  const service = new OfflineHotelCatalogService(prisma, pricing);
  const resolved = await service.resolveOfflineRateOption({
    planId: 1,
    routeId: 999,
    routeDate: '2099-01-02',
    canonicalHotelId: 153,
    rateOptionId: 'offline:153:22:7:2099-01-01:2099-01-03',
    roomCount: 1,
  });
  assert.equal(resolved.routeId, 10);
  assert.equal(calls.length, 2);
});

test('approval and manual confirmation transitions are transactional and idempotent', async () => {
  const row: any = {
    itinerary_plan_hotel_details_ID: 9,
    hotel_provider: 'offline',
    hotel_booking_mode: 'MANUAL_APPROVAL',
    hotel_approval_status: 'PENDING_APPROVAL',
    manual_confirmation_status: 'NOT_STARTED',
    selected_total_price: 9000,
    selected_currency: 'INR',
    selected_price_snapshot: JSON.stringify({ numberOfNights: 2, nightlyRates: [{ baseAmount: 4000 }] }),
  };
  const history: any[] = [];
  const tx: any = {
    dvi_itinerary_plan_hotel_details: {
      findUnique: async () => row,
      update: async ({ data }: any) => Object.assign(row, data),
    },
    dvi_itinerary_plan_hotel_approval_history: { create: async ({ data }: any) => history.push(data) },
  };
  const prisma: any = { $transaction: async (callback: any) => callback(tx), dvi_hotel: { findMany: async () => [] } };
  const service = new ItineraryHotelApprovalService(prisma);
  const approved = await service.approve(9, 4, 'Approved by hotel');
  assert.deepEqual(approved, { success: true, selectionId: 9, approvalStatus: 'APPROVED', manualConfirmationStatus: 'PENDING_CONFIRMATION', requiresPriceReacceptance: false });
  const confirmed = await service.confirmManually(9, 4, 'Confirmation reference recorded');
  assert.equal(confirmed.manualConfirmationStatus, 'CONFIRMED');
  assert.equal(history.length, 2);
  row.hotel_approval_status = 'PENDING_APPROVAL';
  row.manual_confirmation_status = 'NOT_STARTED';
  prisma.dvi_itinerary_plan_hotel_details = { findMany: async () => [row] };
  await assert.rejects(() => service.assertPlanCanFinalize(1), /subject to hotel approval/);
});

test('offline selections are excluded from live supplier booking dispatch', () => {
  const confirmation = new ItineraryConfirmationService({}, {}, {});
  const selected = confirmation.getProviderBookableHotelBookings([
    { provider: 'offline', hotelCode: '153', bookingCode: 'offline:153:22:7:2099-01-01:2099-01-03', netAmount: 9000, isBookable: true },
    { provider: 'axisrooms', hotelCode: '153', bookingCode: 'axis:1', netAmount: 9000, isBookable: true },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].provider, 'axisrooms');
});
