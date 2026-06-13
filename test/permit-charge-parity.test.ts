import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPermitLocationChain,
  RouteEngineService,
} from '../src/modules/itineraries/engines/route-engine.service';

type PermitRow = {
  route_permit_charge_ID: number;
  itinerary_plan_ID: number;
  itinerary_route_ID: number;
  itinerary_route_date: Date;
  vendor_id: number;
  vendor_branch_id: number;
  vendor_vehicle_type_id: number;
  source_state_id: number;
  destination_state_id: number;
  permit_cost: number;
  createdby: number;
  createdon: Date;
  updatedon: Date | null;
  status: number;
  deleted: number;
};

function makeDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function createPermitTxFixture(args?: {
  routes?: any[];
  eligibles?: any[];
  viaRouteRows?: any[];
  vehicles?: any[];
  storedLocations?: any[];
  storedViaLocations?: any[];
  permitStates?: any[];
  permitCosts?: any[];
}) {
  let permitRows: PermitRow[] = [];
  let nextPermitId = 1;

  const routes = args?.routes ?? [];
  const eligibles = args?.eligibles ?? [];
  const viaRouteRows = args?.viaRouteRows ?? [];
  const vehicles = args?.vehicles ?? [];
  const storedLocations = args?.storedLocations ?? [];
  const storedViaLocations = args?.storedViaLocations ?? [];
  const permitStates = args?.permitStates ?? [];
  const permitCosts = args?.permitCosts ?? [];

  const tx: any = {
    dvi_itinerary_plan_route_permit_charge: {
      deleteMany: async ({ where }: any) => {
        permitRows = permitRows.filter((row) => row.itinerary_plan_ID !== where.itinerary_plan_ID);
        return { count: 0 };
      },
      findFirst: async ({ where }: any) => {
        return (
          permitRows.find((row) => {
            return (
              row.itinerary_plan_ID === where.itinerary_plan_ID &&
              row.vendor_id === where.vendor_id &&
              row.vendor_branch_id === where.vendor_branch_id &&
              row.vendor_vehicle_type_id === where.vendor_vehicle_type_id &&
              row.source_state_id === where.source_state_id &&
              row.destination_state_id === where.destination_state_id &&
              row.status === where.status &&
              row.deleted === where.deleted &&
              row.itinerary_route_date >= where.itinerary_route_date.gte
            );
          }) ?? null
        );
      },
      create: async ({ data }: any) => {
        const row: PermitRow = {
          route_permit_charge_ID: nextPermitId++,
          itinerary_plan_ID: Number(data.itinerary_plan_ID),
          itinerary_route_ID: Number(data.itinerary_route_ID),
          itinerary_route_date: new Date(data.itinerary_route_date),
          vendor_id: Number(data.vendor_id),
          vendor_branch_id: Number(data.vendor_branch_id),
          vendor_vehicle_type_id: Number(data.vendor_vehicle_type_id),
          source_state_id: Number(data.source_state_id),
          destination_state_id: Number(data.destination_state_id),
          permit_cost: Number(data.permit_cost),
          createdby: Number(data.createdby),
          createdon: new Date(data.createdon),
          updatedon: data.updatedon ?? null,
          status: Number(data.status),
          deleted: Number(data.deleted),
        };
        permitRows.push(row);
        return row;
      },
    },
    dvi_itinerary_route_details: {
      findMany: async () => routes,
    },
    dvi_itinerary_plan_vendor_eligible_list: {
      findMany: async () => eligibles,
    },
    dvi_itinerary_via_route_details: {
      findMany: async () => viaRouteRows,
    },
    dvi_vehicle: {
      findUnique: async ({ where }: any) =>
        vehicles.find((row) => row.vehicle_id === where.vehicle_id) ?? null,
    },
    dvi_stored_locations: {
      findFirst: async ({ where }: any) => {
        const location = where?.OR?.map((entry: any) => entry.source_location ?? entry.destination_location)
          .find(Boolean);
        return (
          storedLocations.find((row) => {
            return row.source_location === location || row.destination_location === location;
          }) ?? null
        );
      },
    },
    dvi_stored_location_via_routes: {
      findFirst: async ({ where }: any) =>
        storedViaLocations.find((row) => row.via_route_location === where.via_route_location) ?? null,
    },
    dvi_permit_state: {
      findFirst: async ({ where }: any) => {
        if (where.state_code) {
          return permitStates.find((row) => row.state_code === where.state_code) ?? null;
        }
        if (where.state_name) {
          return permitStates.find((row) => row.state_name === where.state_name) ?? null;
        }
        return null;
      },
    },
    dvi_permit_cost: {
      findFirst: async ({ where }: any) =>
        permitCosts.find((row) => {
          return (
            row.vendor_id === where.vendor_id &&
            row.vehicle_type_id === where.vehicle_type_id &&
            row.source_state_id === where.source_state_id &&
            row.destination_state_id === where.destination_state_id &&
            row.status === where.status &&
            row.deleted === where.deleted
          );
        }) ?? null,
    },
  };

  return {
    tx,
    getPermitRows: () => permitRows,
  };
}

function baseFixture() {
  return {
    routes: [
      {
        itinerary_route_ID: 1,
        itinerary_route_date: makeDate('2026-06-01'),
        location_id: 10,
        location_name: 'Mysore',
        next_visiting_location: 'Wayanad',
      },
    ],
    eligibles: [
      {
        itinerary_plan_vendor_eligible_ID: 100,
        vendor_id: 50,
        vendor_branch_id: 7,
        vendor_vehicle_type_id: 200,
        vehicle_id: 300,
        vehicle_orign: 'Bengaluru',
      },
    ],
    viaRouteRows: [],
    vehicles: [{ vehicle_id: 300, registration_number: 'KA01AA1111' }],
    storedLocations: [
      {
        source_location: 'Bengaluru',
        source_location_state: 'Karnataka',
        destination_location: 'Airport',
        destination_location_state: 'Karnataka',
      },
      {
        source_location: 'Mysore',
        source_location_state: 'Karnataka',
        destination_location: 'Wayanad',
        destination_location_state: 'Kerala',
      },
      {
        source_location: 'Wayanad',
        source_location_state: 'Kerala',
        destination_location: 'Mysore',
        destination_location_state: 'Karnataka',
      },
      {
        source_location: 'Ooty',
        source_location_state: 'Tamil Nadu',
        destination_location: 'Mysore',
        destination_location_state: 'Karnataka',
      },
    ],
    storedViaLocations: [
      {
        via_route_location: 'Coonoor',
        via_route_location_state: 'Tamil Nadu',
      },
    ],
    permitStates: [
      { permit_state_id: 11, state_name: 'Karnataka', state_code: 'KA' },
      { permit_state_id: 12, state_name: 'Kerala', state_code: 'KL' },
      { permit_state_id: 23, state_name: 'Tamil Nadu', state_code: 'TN' },
      { permit_state_id: 24, state_name: 'Telangana', state_code: 'TG' },
    ],
    permitCosts: [
      { vendor_id: 50, vehicle_type_id: 200, source_state_id: 11, destination_state_id: 12, permit_cost: 700, status: 1, deleted: 0 },
      { vendor_id: 50, vehicle_type_id: 200, source_state_id: 11, destination_state_id: 23, permit_cost: 500, status: 1, deleted: 0 },
    ],
  };
}

test('buildPermitLocationChain matches PHP first and last route behavior', () => {
  assert.deepEqual(
    buildPermitLocationChain({
      routeCount: 1,
      totalRoutes: 3,
      vehicleOrigin: 'Bengaluru',
      sourceLocation: 'Mysore',
      viaLocations: ['Coonoor'],
      destinationLocation: 'Wayanad',
    }),
    ['Bengaluru', 'Mysore', 'Coonoor', 'Wayanad'],
  );

  assert.deepEqual(
    buildPermitLocationChain({
      routeCount: 3,
      totalRoutes: 3,
      vehicleOrigin: 'Bengaluru',
      sourceLocation: 'Wayanad',
      viaLocations: ['Ooty'],
      destinationLocation: 'Mysore',
    }),
    ['Wayanad', 'Ooty', 'Mysore', 'Bengaluru'],
  );
});

test('single-state route does not create permit rows', async () => {
  const fixture = baseFixture();
  fixture.routes = [
    {
      itinerary_route_ID: 1,
      itinerary_route_date: makeDate('2026-06-01'),
      location_id: 10,
      location_name: 'Mysore',
      next_visiting_location: 'Bengaluru',
    },
  ];
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9001, 1);

  assert.equal(getPermitRows().length, 0);
});

test('route with via states creates permit rows for each visited interstate state', async () => {
  const fixture = baseFixture();
  fixture.viaRouteRows = [
    {
      itinerary_route_ID: 1,
      itinerary_via_location_name: 'Coonoor',
    },
  ];
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9002, 1);

  assert.deepEqual(
    getPermitRows().map((row) => ({
      destination_state_id: row.destination_state_id,
      permit_cost: row.permit_cost,
    })),
    [
      { destination_state_id: 23, permit_cost: 500 },
      { destination_state_id: 12, permit_cost: 700 },
    ],
  );
});

test('duplicate state within 7 days does not create a second permit row', async () => {
  const fixture = baseFixture();
  fixture.routes = [
    {
      itinerary_route_ID: 1,
      itinerary_route_date: makeDate('2026-06-01'),
      location_id: 10,
      location_name: 'Mysore',
      next_visiting_location: 'Ooty',
    },
    {
      itinerary_route_ID: 2,
      itinerary_route_date: makeDate('2026-06-05'),
      location_id: 11,
      location_name: 'Mysore',
      next_visiting_location: 'Ooty',
    },
  ];
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9003, 1);

  assert.equal(getPermitRows().length, 1);
  assert.equal(getPermitRows()[0].destination_state_id, 23);
});

test('same source and destination state does not create a permit row', async () => {
  const fixture = baseFixture();
  fixture.routes = [
    {
      itinerary_route_ID: 1,
      itinerary_route_date: makeDate('2026-06-01'),
      location_id: 10,
      location_name: 'Ooty',
      next_visiting_location: 'Ooty',
    },
  ];
  fixture.vehicles = [{ vehicle_id: 300, registration_number: 'TN01AA1111' }];
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9004, 1);

  assert.equal(getPermitRows().length, 0);
});

test('missing permit cost row does not fail or insert', async () => {
  const fixture = baseFixture();
  fixture.routes = [
    {
      itinerary_route_ID: 1,
      itinerary_route_date: makeDate('2026-06-01'),
      location_id: 10,
      location_name: 'Mysore',
      next_visiting_location: 'Hyderabad',
    },
  ];
  fixture.storedLocations.push({
    source_location: 'Hyderabad',
    source_location_state: 'Telangana',
    destination_location: 'Mysore',
    destination_location_state: 'Karnataka',
  });
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9005, 1);

  assert.equal(getPermitRows().length, 0);
});

test('branch-specific duplicate behavior keeps permits separate per branch', async () => {
  const fixture = baseFixture();
  fixture.routes = [
    {
      itinerary_route_ID: 1,
      itinerary_route_date: makeDate('2026-06-01'),
      location_id: 10,
      location_name: 'Mysore',
      next_visiting_location: 'Ooty',
    },
  ];
  fixture.eligibles = [
    {
      itinerary_plan_vendor_eligible_ID: 100,
      vendor_id: 50,
      vendor_branch_id: 7,
      vendor_vehicle_type_id: 200,
      vehicle_id: 300,
      vehicle_orign: 'Bengaluru',
    },
    {
      itinerary_plan_vendor_eligible_ID: 101,
      vendor_id: 50,
      vendor_branch_id: 8,
      vendor_vehicle_type_id: 200,
      vehicle_id: 301,
      vehicle_orign: 'Bengaluru',
    },
  ];
  fixture.vehicles = [
    { vehicle_id: 300, registration_number: 'KA01AA1111' },
    { vehicle_id: 301, registration_number: 'KA02AA2222' },
  ];
  const { tx, getPermitRows } = createPermitTxFixture(fixture);

  const service = new RouteEngineService();
  await service.rebuildPermitCharges(tx, 9006, 1);

  assert.equal(getPermitRows().length, 2);
  assert.deepEqual(
    getPermitRows().map((row) => row.vendor_branch_id).sort((a, b) => a - b),
    [7, 8],
  );
});
