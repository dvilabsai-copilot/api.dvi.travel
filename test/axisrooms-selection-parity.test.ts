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
