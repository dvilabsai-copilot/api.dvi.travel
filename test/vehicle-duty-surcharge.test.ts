import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRouteVehicleDetails,
  type VehicleCalculationContext,
} from '../src/modules/itineraries/engines/vehicle-calculation.helpers';

const emptyTable = {
  findFirst: async () => null,
  findUnique: async () => null,
  findMany: async () => [],
};

const tables = {
  dvi_stored_locations: {
    ...emptyTable,
    findFirst: async ({ where }: { where: { source_location?: string; destination_location?: string } }) =>
      where.source_location === 'Ooty' && where.destination_location === 'Bangalore'
        ? { distance: 50, duration: '1 hour 0 mins' }
        : null,
  },
  dvi_vehicle_outstation_price_book: { findFirst: async () => ({ day_5: 2500 }) },
  $queryRaw: async () => [],
  $queryRawUnsafe: async () => [],
};

const context: VehicleCalculationContext = {
  prisma: new Proxy(tables, {
    get: (target, key) => Reflect.get(target, key) ?? emptyTable,
  }),
  itinerary_plan_ID: 42,
  vehicle_type_id: 23,
  vendor_id: 4,
  vendor_vehicle_type_ID: 12,
  vendor_branch_id: 4,
  vehicle_location_id: 0,
  vehicle_origin: 'Bangalore',
  vehicle_origin_city: 'Bangalore',
  vehicle_origin_latitude: 0,
  vehicle_origin_longitude: 0,
  extra_km_charge: 12,
  extra_hour_charge: 150,
  get_kms_limit: 250,
  driver_batta: 0,
  food_cost: 0,
  accomodation_cost: 0,
  extra_cost: 0,
  driver_early_morning_charges: 50,
  driver_evening_charges: 50,
  early_morning_charges: 100,
  evening_charges: 100,
  buildCache: {
    storedLocationCity: new Map([['mysore', 'Mysore'], ['ooty', 'Ooty']]),
    locationCoordinates: new Map([
      ['mysore', { latitude: 12.3, longitude: 76.6 }],
      ['ooty', { latitude: 11.4, longitude: 76.7 }],
      ['bangalore', { latitude: 13, longitude: 77.6 }],
    ]),
    vehicleLocationDetails: new Map(),
    viaRouteNames: new Map([[1, []]]),
    routeHotspotMetrics: new Map([[1, {
      runningKm: 100,
      runningSeconds: 7200,
      sightseeingKm: 15,
      sightseeingSeconds: 3600,
    }]]),
    routeLocationId: new Map([['mysore::ooty', 777]]),
    localPoint: new Map(),
    permitCharges: new Map(),
    globalSettings: { localSpeed: 40, outstationSpeed: 60 },
  },
};

test('late duty includes the full garage return on the service day timeline', async (t) => {
  const cases = [
    { guestDrop: '19:00:00', garageReturn: '20:00', hours: 0 },
    { guestDrop: '19:20:00', garageReturn: '20:20', hours: 0.5 },
    { guestDrop: '22:30:00', garageReturn: '23:30', hours: 3.5 },
    { guestDrop: '23:00:00', garageReturn: '00:00', hours: 4 },
    { guestDrop: '23:30:00', garageReturn: '00:30', hours: 4.5 },
  ];

  for (const { guestDrop, garageReturn, hours } of cases) {
    await t.test(`guest drop ${guestDrop}, garage return ${garageReturn}`, async () => {
      const result = await calculateRouteVehicleDetails(context, {
        itinerary_route_ID: 1,
        itinerary_route_date: new Date('2027-01-05T12:00:00.000Z'),
        location_name: 'Mysore',
        next_visiting_location: 'Ooty',
        no_of_km: 100,
        route_start_time: '09:00:00',
        route_end_time: guestDrop,
      }, 3, 3, 'Mysore');

      assert.equal(result.TOTAL_DROP_DURATION, '01:00:00');
      assert.equal(result.morning_extra_time, 0);
      assert.equal(result.evening_extra_time, hours);
      assert.equal(result.DRIVER_EVEINING_CHARGES, hours * 50);
      assert.equal(result.VENDOR_VEHICLE_EVENING_CHARGES, hours * 100);
      assert.equal(result.TOTAL_VEHICLE_AMOUNT, 2500 + hours * 150);
    });
  }
});
