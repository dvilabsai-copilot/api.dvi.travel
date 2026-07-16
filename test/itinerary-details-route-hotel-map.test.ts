import assert from 'node:assert/strict';
import test from 'node:test';
import { ItineraryDetailsRouteHotelMapService } from '../src/modules/itineraries/services/itinerary-details-route-hotel-map.service';

function createPrisma() {
  return {
    dvi_itinerary_plan_hotel_details: {
      findMany: async () => [{ hotel_id: 10, hotel_code: '', itinerary_route_id: 1, group_type: 1 }],
    },
    dvi_confirmed_itinerary_plan_hotel_details: { findMany: async () => [] },
    dvi_hotel: {
      findMany: async () => [{ hotel_id: 10, hotel_name: 'Local Hotel', hotel_address: 'Main Road' }],
    },
    tbo_hotel_booking_confirmation: {
      findMany: async () => [{ itinerary_route_ID: 2, tbo_hotel_code: 'TBO-2' }],
    },
    tbo_hotel_master: {
      findMany: async () => [{ tbo_hotel_code: 'TBO-2', hotel_name: 'TBO Hotel', hotel_address: 'Beach Road' }],
    },
  };
}

test('hydrates local and confirmed-provider hotel display precedence', async () => {
  const service = new ItineraryDetailsRouteHotelMapService();
  const map = await service.build({
    prisma: createPrisma(),
    planId: 42,
    confirmedPlan: false,
    groupType: 1,
    routes: [{ itinerary_route_ID: 1 }, { itinerary_route_ID: 2 }],
    isVehicleOnly: false,
  });

  assert.deepEqual(map.get(1), {
    hotel_id: 10,
    hotel_name: 'Local Hotel',
    hotel_address: 'Main Road',
    hotel_code: '',
  });
  assert.equal(map.has(2), false);
});

test('applies vehicle-only display labels to hydrated routes', async () => {
  const service = new ItineraryDetailsRouteHotelMapService();
  const prisma = createPrisma();
  prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany = async () => [
    { hotel_id: 0, hotel_code: 'TBO-2', itinerary_route_id: 2, group_type: 1 },
  ];
  const map = await service.build({
    prisma,
    planId: 42,
    confirmedPlan: true,
    routes: [{ itinerary_route_ID: 2 }],
    isVehicleOnly: true,
  });

  assert.equal(map.get(2)?.hotel_name, 'Hotel');
  assert.equal(map.get(2)?.hotel_address, null);
});
