# Test Matrix

| Area | Existing coverage | Baseline status | Required next evidence |
|---|---|---|---|
| Backend pure algorithms | route optimizer, cross-day optimizer, arrival policy, permit parity, payments validation | 13/14 pass; one known failure | classify/fix the optimizer baseline before extraction |
| Backend unit services | limited | insufficient | typed Nest mocks for target responsibility |
| Backend integration | no standard isolated MySQL harness found | not run | local/test MySQL fixture, rollback/constraint checks |
| API/Supertest | endpoint sweep script exists; no broad test suite found | not run | app factory with same prefix/pipes/guards |
| Frontend unit/component | 4 files, 9 tests | PASS | itinerary-details loading/error/preview characterization |
| OpenAPI | runtime coverage checker exists | generator/comparator added | generate baseline and compare route contracts |
| Playwright | 40+ scenario files, grouped runner | not run | run deterministic smoke, then itinerary/manual-hotspot fixtures |
| Database performance | ad hoc scripts and Prisma schema | not measured | read-only inventory and query instrumentation |
