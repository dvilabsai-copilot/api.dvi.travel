import assert from 'node:assert/strict';
import test from 'node:test';
import { ItinerariesService } from '../src/modules/itineraries/itineraries.service';
import { ItinerarySelectionWorkflowService } from '../src/modules/itineraries/services/itinerary-selection-workflow.service';
import { latestAxisRoomsOccupancyValues } from '../src/modules/itineraries/utils/axisrooms-occupancy-rate.util';
import { ItineraryHotelRoomCategoryService } from '../src/modules/itineraries/services/itinerary-hotel-room-category.service';
import { resolveHotelOccupancyPricing } from '../src/modules/itineraries/utils/hotel-selection-pricing.util';

const date = '2026-12-06';
function services(rows: any[], plan: any, margin: number) {
  const prisma: any = {
    dvi_hotel_occupancy_rate: { findMany: async ({ where }: any) => {
      assert.equal(where.start_date.lte.toISOString().slice(0, 10), date);
      assert.equal(where.end_date.gte.toISOString().slice(0, 10), date);
      return rows.filter(row => row.rateplan_id === where.rateplan_id);
    } },
    dvi_hotel: { findUnique: async () => ({ hotel_margin: margin }) },
    dvi_itinerary_plan_details: { findUnique: async () => plan },
  };
  const preview = Object.create(ItinerariesService.prototype) as any;
  preview.prisma = prisma;
  return { preview, save: new ItinerarySelectionWorkflowService(prisma, null as any, null as any, null as any) as any };
}

for (const [meal, base, payable] of [['MAP', 4700, 5029], ['AP', 5900, 6313]] as const) {
  test(`explicit ${meal} is quoted and saved instead of the itinerary CP preference`, async () => {
    const plan = { preferred_room_count: 1, total_adult: 2, meal_plan_code: 'CP' };
    const { preview, save } = services([
      { rateplan_id: 'CP_PLAN', occupancy_rates: { DOUBLE: 3500 } },
      { rateplan_id: `${meal}_PLAN`, occupancy_rates: { DOUBLE: base } },
    ], plan, 7);
    const option = { provider: 'axisrooms', canonicalHotelId: 95, roomId: 232,
      mealPlan: meal, rateplanId: `232|${meal}_PLAN`, ratePlanId: `232|${meal}_PLAN`, rateId: `232|${meal}_PLAN`,
      rateOptionId: `axisrooms:95:232:232|${meal}_PLAN:${date}`, roomCount: 1, planId: 1 };
    const quote = await preview.resolveAxisRoomsSelectionPricing(option, plan, date);
    assert.equal(quote.totalPrice, payable);
    assert.equal(quote.rateplanId, `${meal}_PLAN`);
    const baseSaved = await save.resolveAxisRoomsSelectionBasePrice(option, { itinerary_route_date: new Date(date) });
    assert.equal(Number((baseSaved * 1.07).toFixed(2)), payable);
  });
}

test('Arbour preview and save choose the newest received complete row and its supplements', async () => {
  const plan = { preferred_room_count: 2, total_adult: 5, total_extra_bed: 1, meal_plan_code: 'CP' };
  const rows = [
    { rateplan_id: 'CP_PLAN', received_at: '2026-08-01', start_date: '2026-12-01', occupancy_rates: { DOUBLE: 3200, EXTRABED: 100 } },
    { rateplan_id: 'CP_PLAN', received_at: '2026-09-29', start_date: '2026-10-01', occupancy_rates: { DOUBLE: 6250, EXTRABED: 800 } },
    { rateplan_id: 'CP_PLAN', received_at: '2026-10-01', start_date: '2026-12-01', occupancy_rates: { EXTRABED: 9900 } },
  ];
  const { preview, save } = services(rows, plan, 6);
  const option = { planId: 1, provider: 'axisrooms', canonicalHotelId: 232, roomId: 606, roomCount: 2,
    rateOptionId: `axisrooms:232:606:606|CP_PLAN:${date}` };
  const quote = await preview.resolveAxisRoomsSelectionPricing(option, plan, date);
  assert.equal(quote.totalPrice, 14098);
  const route = { itinerary_route_date: new Date(date) };
  const base = await save.resolveAxisRoomsSelectionBasePrice(option, route);
  const supplements = await save.resolveAxisRoomsSelectionSupplementRates(option, route, plan);
  assert.equal(base, 12500);
  assert.equal(supplements.extraBedRate, 800);
  assert.equal(Number(((base + supplements.extraBedRate) * 1.06).toFixed(2)), quote.totalPrice);
  assert.deepEqual(rows[0].occupancy_rates, { DOUBLE: 3200, EXTRABED: 100 });
});

test('ARI row selection handles receipt ties, malformed data, single occupancy and empty rates', () => {
  const rows = [
    { received_at: '2026-10-01', start_date: '2026-10-01', occupancy_rates: { SINGLE: 100, DOUBLE: 200 } },
    { received_at: '2026-10-01', start_date: '2026-11-01', occupancy_rates: '{"SINGLE":150,"DOUBLE":250}' },
    { received_at: '2026-11-01', occupancy_rates: '{bad' },
  ];
  assert.equal(latestAxisRoomsOccupancyValues(rows, 'SINGLE')?.SINGLE, 150);
  assert.equal(latestAxisRoomsOccupancyValues(rows, 'DOUBLE')?.DOUBLE, 250);
  assert.equal(latestAxisRoomsOccupancyValues([], 'DOUBLE'), null);
  assert.equal(latestAxisRoomsOccupancyValues([{ occupancy_rates: { EXTRABED: 900 } }], 'DOUBLE'), null);
});

test('mixed AX room categories price CP bases and their own extra bed instead of supplement-only rows', async () => {
  const rows = [
    { room_id: 231, rateplan_id: 'CP_PLAN', received_at: '2026-09-01', occupancy_rates: { DOUBLE: 4500, EXTRABED: 700 } },
    { room_id: 232, rateplan_id: 'CP_PLAN', received_at: '2026-09-01', occupancy_rates: { DOUBLE: 3500, EXTRABED: 1000 } },
    { room_id: 231, rateplan_id: 'CP_PLAN', received_at: '2026-10-01', occupancy_rates: { EXTRABED: 5200 } },
    { room_id: 231, rateplan_id: 'AP_PLAN', received_at: '2026-11-01', occupancy_rates: { DOUBLE: 6900, EXTRABED: 1900 } },
  ];
  const service: any = new ItineraryHotelRoomCategoryService({
    dvi_hotel_occupancy_rate: { findMany: async ({ where }: any) => {
      assert.equal(where.rateplan_id, 'CP_PLAN');
      return rows.filter(row => row.room_id === where.room_id && row.rateplan_id === where.rateplan_id);
    } },
  } as any, {} as any);
  const pricing = await Promise.all([231, 232].map(async (id, index) => resolveHotelOccupancyPricing({
    rates: await service.resolveOccupancyRates(95, id, new Date(date), 'CP_PLAN', 'DOUBLE'),
    roomCount: 1, adultCount: index === 0 ? 3 : 2, extraBedCount: index === 0 ? 1 : 0, marginPercentage: 7,
  })));
  assert.deepEqual(pricing.map(p => p.roomRate), [4500, 3500]);
  assert.deepEqual(pricing.map(p => p.extraBedAmount), [700, 0]);
  assert.equal(pricing.reduce((sum, p) => sum + p.totalPrice, 0), 9309);
});

test('category save replaces old snapshot nightly prices with the persisted payable', async () => {
  let saved: any;
  const parent = { itinerary_plan_hotel_details_ID: 10, hotel_id: 95, hotel_margin_percentage: 7,
    selected_price_snapshot: JSON.stringify({ provider: 'axisrooms', mealPlan: 'CP', roomType: 'Deluxe',
      roomId: 232, pricePerNight: 999, selectedPricePerNight: 999,
      rateOptionId: `axisrooms:95:232:232|CP_PLAN:${date}` }) };
  const service: any = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: new Date(date) }) },
    dvi_itinerary_plan_details: { findFirst: async () => ({ preferred_room_count: 1, total_adult: 2, meal_plan_code: 'CP' }) },
    dvi_itinerary_plan_hotel_details: { findFirst: async () => parent, update: async ({ data }: any) => { saved = data; } },
    dvi_itinerary_plan_hotel_room_details: { update: async () => ({}),
      findMany: async () => [{ room_qty: 1, room_id: 232, room_type_id: 30 }] },
    dvi_hotel_occupancy_rate: { findMany: async () => [{ occupancy_rates: { DOUBLE: 3500 }, received_at: '2026-10-01' }] },
  } as any, {} as any);
  service.resolveAvailableRoomTypes = async () => [{ roomTypeId: 30, roomId: 232, roomTypeTitle: 'Deluxe' }];
  await service.updateRoomCategory({ itinerary_plan_hotel_details_ID: 10, itinerary_plan_hotel_room_details_ID: 20,
    itinerary_plan_id: 1, itinerary_route_id: 2, hotel_id: 95, group_type: 1, provider: 'axisrooms',
    room_type_id: 30, propagateContinuous: false });
  const snapshot = JSON.parse(saved.selected_price_snapshot);
  assert.equal(saved.selected_price_per_night, 3745);
  assert.equal(snapshot.pricePerNight, saved.selected_price_per_night);
  assert.equal(snapshot.selectedPricePerNight, saved.selected_price_per_night);
  assert.equal(snapshot.totalPrice, saved.selected_total_price);
});

test('editing automatic AX categories restores a missing extra bed and keeps it on repeat', async () => {
  const rooms = [
    { itinerary_plan_hotel_room_details_ID: 20, room_qty: 1, room_id: 231, room_type_id: 1330, extra_bed_count: 0, extra_bed_rate: 0 },
    { itinerary_plan_hotel_room_details_ID: 21, room_qty: 1, room_id: 232, room_type_id: 30, extra_bed_count: 0, extra_bed_rate: 0 },
  ];
  const parent = { itinerary_plan_hotel_details_ID: 10, hotel_id: 95, hotel_margin_percentage: 7,
    selected_price_snapshot: JSON.stringify({ provider: 'axisrooms', mealPlan: 'CP', roomType: 'Deluxe',
      totalRoomCost: 7000, totalPrice: 8560, extraBedCount: 1 }) };
  let saved: any;
  const service: any = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: new Date(date) }) },
    dvi_itinerary_plan_details: { findFirst: async () => ({ preferred_room_count: 2, total_adult: 5, total_extra_bed: 1, meal_plan_code: 'CP' }) },
    dvi_itinerary_plan_hotel_details: { findFirst: async () => parent, update: async ({ data }: any) => { saved = data; } },
    dvi_itinerary_plan_hotel_room_details: { findMany: async () => rooms,
      update: async ({ where, data }: any) => Object.assign(rooms.find(r => r.itinerary_plan_hotel_room_details_ID === where.itinerary_plan_hotel_room_details_ID)!, data) },
    dvi_itinerary_traveller_details: { findMany: async () => [1, 1, 1, 2, 2].map(room_id => ({ room_id, traveller_type: 1 })) },
    dvi_hotel_occupancy_rate: { findMany: async ({ where }: any) => [{ occupancy_rates: { DOUBLE: where.room_id === 231 ? 4000 : 3500, EXTRABED: 1000 } }] },
  } as any, {} as any);
  service.resolveAvailableRoomTypes = async () => [
    { roomTypeId: 1330, roomId: 231, roomTypeTitle: 'Valley View Double' },
    { roomTypeId: 30, roomId: 232, roomTypeTitle: 'Deluxe' },
  ];
  for (const room of rooms) {
    await service.updateRoomCategory({ itinerary_plan_hotel_details_ID: 10,
      itinerary_plan_hotel_room_details_ID: room.itinerary_plan_hotel_room_details_ID,
      itinerary_plan_id: 1, itinerary_route_id: 2, hotel_id: 95, group_type: 1, provider: 'axisrooms',
      room_type_id: room.room_type_id, propagateContinuous: false });
    const snapshot = JSON.parse(saved.selected_price_snapshot);
    assert.deepEqual(rooms.map(r => r.extra_bed_count), [1, 0]);
    assert.deepEqual(snapshot.roomTypeBreakdown.map((r: any) => r.extraBedCost), [1000, 0]);
    assert.equal(snapshot.totalRoomCost, 7500);
    assert.equal(snapshot.pricePerNight, 9095);
    assert.equal(saved.total_extra_bed_cost, 1000);
    assert.equal(saved.selected_price_per_night, 9095);
  }
});

test('a mixed AX meal quote prices each saved room and requires every saved category', async () => {
  const plan = { preferred_room_count: 2, total_adult: 5, total_extra_bed: 1 };
  const { preview } = services([], plan, 7);
  preview.prisma.dvi_hotel_occupancy_rate.findMany = async ({ where }: any) => [{
    rateplan_id: where.rateplan_id,
    occupancy_rates: { DOUBLE: where.room_id === 231 ? 5200 : 4700, EXTRABED: 1600 },
  }];
  const rooms = [
    { roomNumber: 1, roomId: 231, roomTypeId: 1330, roomType: 'Valley View Double' },
    { roomNumber: 2, roomId: 232, roomTypeId: 30, roomType: 'Deluxe' },
  ];
  const occupancy = [
    { roomNumber: 1, adultCount: 3, extraBedCount: 1 },
    { roomNumber: 2, adultCount: 2, extraBedCount: 0 },
  ];
  const options = rooms.map(room => ({ ...room, canonicalHotelId: 95, rateplanId: 'MAP_PLAN', mealPlan: 'MAP' }));
  const quote = await preview.repriceMixedAxisRoomsMeal(rooms, occupancy, options, plan, date);
  assert.deepEqual(quote.roomSelections, rooms);
  assert.equal(quote.totalPrice, 12305);
  assert.equal(quote.baseTotalPrice, 9900);
  assert.equal(quote.extraBedAmount, 1600);
  assert.deepEqual(quote.axisRoomsMealRooms.map((room: any) => room.pricing.extraBedCount), [1, 0]);
  assert.equal(await preview.repriceMixedAxisRoomsMeal(rooms, occupancy, options.slice(1), plan, date), null);
});

test('a legacy AX aggregate is attached or retired for the exact room-night scope', async () => {
  const routeDate = new Date(date);
  const legacy = { itinerary_plan_hotel_room_details_ID: 22, room_qty: 2, group_type: 0, itinerary_route_date: null };
  const calls: any[] = [];
  let datedRooms: any[] = [];
  const service: any = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_plan_hotel_room_details: {
      findMany: async ({ where }: any) => where.itinerary_route_date ? datedRooms : [legacy],
      updateMany: async (request: any) => { calls.push(request); },
    },
  } as any, {} as any);
  const input = { hotelDetailsId: 10, planId: 1, routeId: 2, routeDate, groupType: 1, roomCount: 2, now: new Date() };
  await service.reconcileUndatedAxisRoomsRoom(input);
  assert.equal(calls[0].where.itinerary_plan_hotel_room_details_ID, 22);
  assert.equal(calls[0].data.itinerary_route_date, routeDate);
  datedRooms = [{ room_qty: 1, room_id: 231 }, { room_qty: 1, room_id: 232 }];
  await service.reconcileUndatedAxisRoomsRoom(input);
  assert.equal(calls[1].where.itinerary_plan_hotel_details_id, 10);
  assert.equal(calls[1].where.itinerary_route_id, 2);
  assert.equal(calls[1].where.itinerary_route_date, null);
  assert.equal(calls[1].data.deleted, 1);
});

test('batch edits use the saved AxisRooms anchor to find the matching adjacent night', async () => {
  const parents = [
    { itinerary_plan_hotel_details_ID: 31, itinerary_route_id: 21, itinerary_route_date: '2027-01-18', hotel_provider: 'axisrooms', hotel_code: 'AX_DVI_HOTEL_238' },
    { itinerary_plan_hotel_details_ID: 32, itinerary_route_id: 22, itinerary_route_date: '2027-01-19', hotel_provider: 'axisrooms', hotel_code: 'AX_DVI_HOTEL_238' },
    { itinerary_plan_hotel_details_ID: 33, itinerary_route_id: 23, itinerary_route_date: '2027-01-19', hotel_provider: 'axisrooms', hotel_code: 'different-property' },
    { itinerary_plan_hotel_details_ID: 34, itinerary_route_id: 24, itinerary_route_date: '2027-01-19', hotel_provider: 'offline', hotel_code: 'AX_DVI_HOTEL_238' },
    { itinerary_plan_hotel_details_ID: 35, itinerary_route_id: 25, itinerary_route_date: '2027-01-20', hotel_provider: 'axisrooms', hotel_code: 'AX_DVI_HOTEL_238' },
  ];
  const service: any = new ItineraryHotelRoomCategoryService({
    dvi_itinerary_route_details: { findUnique: async () => ({ itinerary_route_date: new Date('2027-01-18') }) },
    dvi_itinerary_plan_hotel_details: { findMany: async ({ where }: any) => {
      assert.equal(where.hotel_id, 238);
      assert.equal(where.itinerary_plan_id, 10);
      assert.equal(where.group_type, 4);
      return parents;
    } },
  } as any, {} as any);
  const calls: any[] = [];
  service.updateRoomCategory = async (params: any) => {
    calls.push(params);
    return { itinerary_plan_hotel_details_ID: params.itinerary_route_id === 21 ? 31 : 32 };
  };
  await service.updateRoomCategories({
    itinerary_plan_hotel_details_ID: 0, itinerary_plan_id: 10, itinerary_route_id: 21,
    hotel_id: 238, group_type: 4, hotel_code: '238', provider: 'axisrooms',
    rooms: [{ room_number: 1, room_type_id: 1 }, { room_number: 2, room_type_id: 19 }],
  });
  assert.deepEqual(calls.map(call => [call.itinerary_route_id, call.room_number]), [[21, 1], [21, 2], [22, 1], [22, 2]]);
  assert.ok(calls.slice(2).every(call => call.itinerary_plan_hotel_details_ID === 32 && call.propagateContinuous === false));
});
