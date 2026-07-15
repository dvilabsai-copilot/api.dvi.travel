# Test Data Contract

Tests must use deterministic, isolated data. Production credentials, customer data, live payment calls and irreversible provider operations are out of scope.

## Required fixture domains

- itinerary plan with ordered routes and at least two hotspots;
- manual hotspot candidate with operating hours and coordinates;
- hotel, room, rate plan and meal/price-book rows;
- vendor, vehicle type, vehicle, slab and permit-cost rows;
- activity, timeslot and price-book rows;
- stored locations and directional distance data;
- agent/user authentication fixture with role coverage.

## Required assertions

Assert status codes, response shape, ordering, calculations, persisted rows, soft-delete/status filters, rollback behavior and route precedence. Values derived from live production data are not valid test fixtures.
