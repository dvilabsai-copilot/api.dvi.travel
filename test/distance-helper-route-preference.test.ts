import assert from 'node:assert/strict';
import test from 'node:test';
import { DistanceHelper } from '../src/modules/itineraries/engines/helpers/distance.helper';

function makeDb(storedRoute: Record<string, unknown> | null) {
  return {
    dvi_stored_locations: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (
          storedRoute &&
          where.source_location === storedRoute.source_location &&
          where.destination_location === storedRoute.destination_location
        ) {
          return storedRoute;
        }
        return null;
      },
    },
    dvi_global_settings: {
      findFirst: async () => null,
    },
  };
}

const cityRoute = {
  location_ID: 118032n,
  source_location: 'Bangalore, International Airport',
  destination_location: 'Wayanad, Kerala, India',
  distance: 311.934,
  duration: '4 hours 15 mins',
  deleted: 0,
};

const airportCoords = { lat: 13.1992026, lon: 77.7073776 };
const wayanadCoords = { lat: 11.703206, lon: 76.0833999 };

test('explicit direct city route preference uses stored driving distance and duration', async () => {
  const helper = new DistanceHelper();
  const result = await helper.fromSourceAndDestination(
    makeDb(cityRoute) as any,
    cityRoute.source_location,
    cityRoute.destination_location,
    2,
    airportCoords,
    wayanadCoords,
    true,
  );

  assert.equal(result.distanceKm, 311.934);
  assert.equal(result.travelTime, '04:15:00');
});

test('other callers keep coordinate-first distance behavior by default', async () => {
  const helper = new DistanceHelper();
  const result = await helper.fromSourceAndDestination(
    makeDb(cityRoute) as any,
    cityRoute.source_location,
    cityRoute.destination_location,
    2,
    airportCoords,
    wayanadCoords,
  );

  assert.ok(Math.abs(result.distanceKm - 363.61) < 0.02);
});

test('missing stored city route falls back to valid coordinates', async () => {
  const helper = new DistanceHelper();
  const result = await helper.fromSourceAndDestination(
    makeDb(null) as any,
    cityRoute.source_location,
    cityRoute.destination_location,
    2,
    airportCoords,
    wayanadCoords,
    true,
  );

  assert.ok(Math.abs(result.distanceKm - 363.61) < 0.02);
});
