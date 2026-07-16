# Refactoring Progress

## Repository state

- Backend branch: `main`
- Backend commit at start: `aec9541`
- Frontend branch: `main`
- Frontend commit at start: `b2bbaec`
- Database environment: configured MySQL connection; credentials intentionally omitted
- Database name: not recorded
- MySQL version: not collected
- Prisma version: 5.20.x
- NestJS version: 10.3.x
- React version: 18.3.x
- Node version: runtime present; exact version not recorded in this document
- Package manager: npm
- Test date: 2026-07-16

## Current working state

- Backend working branch: `codex/itinerary-modernization-20260716`
- Backend current commit: `b331633`
- Frontend working branch: `codex/itinerary-modernization-20260716`
- The baseline above remains the original `main` snapshot; current-tier results are appended below and do not overwrite baseline findings.

- Latest retained backend commit: `a5a46e0`

## Baseline status

- Backend unit/algorithm tests: 13 passed, 1 pre-existing failure (`route-optimizer-normalization`)
- Backend integration tests: not run; isolated fixture not established
- API tests: not run
- Frontend tests: 9 passed across 4 files
- Swagger generation: passed after explicit GraphQL scalar metadata fix; 499 paths / 603 operations
- Swagger contract comparison: PASS after contract-repair cycle; 603 operations, no drift, duplicate IDs or broken schema references
- Playwright: not run; environment/fixtures require explicit safe configuration
- Backend build: passed
- Frontend build: passed
- Prisma validation: passed
- Frontend lint: failed on pre-existing 1,636 errors and 82 warnings, primarily explicit `any` usage and generated/public assets

## Refactoring cycles

### Cycle 1 — Baseline evidence and OpenAPI generation

#### Scope

- Original files: repository configuration and GraphQL metadata only; no domain extraction
- New files: active call graph, baseline, decomposition plan, test matrix/data contract, Swagger contract documentation, database usage/optimization documentation, OpenAPI generator/comparator
- Endpoints: all active REST endpoints represented by generated OpenAPI
- UI workflow: itinerary details route and existing Playwright coverage inventoried
- Tables: static Prisma model/index inventory only

#### Baseline

- High-risk files measured from the current tree; see `service-decomposition-plan.md`
- Query counts/timings: not claimed; safe fixture not yet measured
- Swagger paths: 499; operations: 603
- Existing tests: frontend 9/9 pass; backend 13/14 pass

#### Change

- Added repeatable OpenAPI generation and contract comparison scripts.
- Added explicit nullable GraphQL `String` metadata for `DashboardDailyMomentV2Type` and `DashboardStarPerformerV2Type`, allowing Swagger bootstrap to complete without changing runtime values.
- No service extraction, query optimization, index mutation, route change or database write.

#### Verification

- Backend build: PASS
- Prisma validation: PASS
- OpenAPI generation: PASS
- OpenAPI self-comparison: route parity PASS; duplicate IDs/schema refs FAIL as existing findings
- Frontend unit tests/build: PASS
- Frontend lint: pre-existing failure
- Playwright/API/integration: pending safe fixture

#### Result

- Baseline retained and committed.
- Remaining risks: existing route optimizer test failure, Swagger metadata defects, broad lint debt, missing isolated integration fixture.

### Cycle 2 — Route optimizer normalization wiring

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Responsibility: route-chain normalization, duplicate-stop removal and terminal-anchor protection
- Endpoint/UI workflow: itinerary save with route optimization; no controller or frontend route changed
- Tables: none directly; distance lookup remains behind the existing service method

#### Baseline

- Original file size: 37,413 lines
- Existing focused result: 13 passed / 1 failed
- Failure: `route-optimizer-normalization.test.ts` expected duplicate/terminal normalization that `optimizeRouteOrder()` did not invoke
- Query count/timing: not measured; test uses a stubbed distance method

#### Change

- Routed `optimizeRouteOrder()` through its existing `extractRouteOptimizationContext()` helpers.
- Preserved broken route chains and terminal-anchor-only artifacts in original order.
- Removed the PHP-parity length guard for normalized output so duplicate movable stops can be removed safely.
- No API route, DTO, response contract, transaction, query, index or frontend change.

#### Verification

- Route optimizer test: PASS
- Focused backend suite: 14/14 PASS
- Backend build: PASS
- OpenAPI route/contract parity: PASS against baseline
- OpenAPI quality checks: existing 14 duplicate operation IDs and 2 broken schema references remain

#### Result

- Behaviour characterization now passes for route normalization, duplicate stops, terminal anchors and broken chains.
- Retained and ready for the next small extraction only after the Swagger findings are either fixed or explicitly bounded.

### Cycle 3 — Swagger/OpenAPI contract repair

#### Scope

- Original files: `src/main.ts`, `src/modules/locations/locations.controller.ts`, GraphQL/dashboard metadata
- New file: `src/common/swagger/normalize-openapi.ts`
- Endpoint/UI workflow: all REST documentation; no route handler or frontend API call changed
- Tables: none

#### Baseline

- OpenAPI generation: 499 paths / 603 operations
- Existing findings: 14 duplicate operation IDs from the dual-prefix STAAH controller and 2 unregistered location response DTO references
- Contract drift: 0 when comparing route/method/request/response contracts

#### Change

- Registered `ViaRouteResponseDto` and `SuggestedRouteResponseDto` with the Locations controller.
- Added deterministic unique operation IDs for duplicate alias operations while preserving the first public operation ID and all HTTP routes.
- Applied the same normalization to runtime Swagger setup and the baseline generator.

#### Verification

- Backend build: PASS
- OpenAPI generation: PASS; configured MySQL connection initialized
- OpenAPI comparison: PASS — 603 routes, no missing/added/changed contracts, no duplicate IDs, no broken refs
- Prisma validation: PASS
- Backend focused tests: PASS, 14/14

#### Result

- Contract tier retained and committed.
- Remaining risk: runtime route-precedence coverage still needs an isolated API test; no route definitions were changed in this cycle.

### Cycle 4 — Extract itinerary route normalization policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: pure route-chain normalization, terminal-anchor recognition, broken-chain detection and movable-stop deduplication
- New files: `src/modules/itineraries/services/itinerary-route-normalization.service.ts`, `test/itinerary-route-normalization.test.ts`
- Endpoint/UI workflow: itinerary save route optimization; existing controller/API shape unchanged
- Tables: none

#### Baseline

- Original file size: 37,413 lines; static DB-call matches: 607
- Route normalization characterization: embedded in optimizer test; 14/14 focused backend tests passed before extraction
- Query count, DB duration and endpoint duration: not applicable to pure policy; distance method remains stubbed in tests
- Swagger operations: 603

#### Change

- Moved normalization policy methods behind `ItineraryRouteNormalizationService`.
- Kept `ItinerariesService` as the public compatibility facade and injected the new provider through `ItinerariesModule`.
- Added direct unit coverage for duplicate movable stops, broken chains and terminal anchors.
- No query, transaction, DTO, route, response, index or frontend change.

#### Verification

- Normalizer unit tests: PASS, 3/3
- Combined focused backend suite: PASS, 17/17
- Backend build: PASS
- Prisma validation: not rerun after pure extraction; prior checkpoint PASS
- OpenAPI comparison: not rerun after pure extraction; no controller metadata changed
- Frontend tests/build: prior checkpoint PASS
- Playwright: preflight and audit PASS; workflow execution pending configured fixture

#### Result

- Extraction retained.
- Original facade is smaller and route policy now has a narrow public interface.
- Remaining risk: constructor still coordinates many unrelated services; future extractions must preserve transaction boundaries and provider behavior.

### Cycle 5 — Extract timeline operating-hours policy

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: timing-value formatting, operating-window summaries and closed-day checks
- New files: `src/modules/itineraries/engines/helpers/timeline-operating-hours.service.ts`, `test/timeline-operating-hours.test.ts`
- Endpoint/UI workflow: itinerary timeline generation; existing route, response and timing behavior preserved
- Tables: none

#### Baseline

- Original file size: 10,398 lines; static DB-call matches: 49
- Operating-hours policy was embedded in the 10k-line timeline builder.
- Query count, DB duration and endpoint duration: not applicable to this pure policy extraction.
- Swagger operations: 603

#### Change

- Moved the pure operating-hours formatting and daily policy calculations behind `TimelineOperatingHoursService`.
- Kept `TimelineBuilder` as the compatibility facade and preserved its existing manual construction path.
- Added direct coverage for timing summaries, closed-day behavior, missing timing records and overnight windows.
- No query, transaction, DTO, route, response, index or frontend change.

#### Verification

- Operating-hours unit tests: PASS, 3/3
- Combined focused backend suite: PASS, 20/20
- Backend build: PASS
- Prisma/OpenAPI/frontend checks: covered by the next two-tier checkpoint

#### Result

- Extraction retained.
- Timeline operating-hours policy now has a narrow, independently testable interface.
- Remaining risk: timeline ordering and hotspot selection remain in the facade and require characterization before further extraction.

### Current checkpoint evidence

- Backend route-normalization and operating-hours focused suite: PASS, 20/20
- Frontend unit suite: PASS, 9/9
- Frontend production build: PASS
- Playwright smoke: PASS, 7/7
- Playwright inventory/audit: PASS, 96 routes, 2,062 controls, 990 API references, 66 classified routes
- Frontend lint: pre-existing failure, 1,636 errors and 82 warnings; no lint-only cleanup included
- Database query/index optimization: not changed; no before/after production measurements claimed

### Cycle 8 — Complete timeline operating-hours delegation

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility: full visit-window eligibility check, including overnight windows, open-all-time rows and next-window selection
- Existing extracted file: `src/modules/itineraries/engines/helpers/timeline-operating-hours.service.ts`

#### Change

- Delegated the remaining `checkHotspotOperatingHoursFromMap` implementation to the extracted policy service.
- Preserved the `TimelineBuilder` method signature and all call sites, so timeline orchestration and wait-until-open behavior remain unchanged.
- No query, transaction, DTO, route, response, index or frontend change.

#### Verification

- Timeline operating-hours tests: PASS, 3/3
- Combined focused backend suite: PASS, 20/20
- Backend build: PASS

#### Result

- Operating-hours behavior is now fully centralized in the narrow policy service; `TimelineBuilder` remains the compatibility facade.
- Commit: `api.dvi.travel` `baf0722`.

### Cycle 9 — Evidence-gated index migration artifact

#### Scope

- New files: `docs/performance/index-proposals.sql`, `docs/performance/index-analysis.md`
- Workflow: database change governance only; no application or schema behavior changed

#### Change

- Added explicit no-op UP and DOWN sections, read-only validation SQL, and locking/rollout constraints.
- Recorded that current evidence is insufficient for an index addition, duplicate removal or missing-index claim.
- No migration was applied and no index definition was changed.

### Full-decomposition iteration 1 — Extract timeline slot policy

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: morning/evening slot classification, wait-until-open policy, next-slot selection, max-time selection and free-time row construction
- New files: `src/modules/itineraries/engines/helpers/timeline-slot-policy.service.ts`, `test/timeline-slot-policy.test.ts`

#### Verification

- Original facade: 10,302 → 10,254 lines
- Extracted service: 79 lines
- Slot-policy tests: PASS, 3/3
- Combined backend focused suite: PASS, 26/26
- Backend build: PASS

#### Compatibility

- `TimelineBuilder` remains the compatibility facade.
- No controller, route, DTO, response, Prisma query, transaction or frontend change.
- Commit: `api.dvi.travel` `0823c22`.

### Full-decomposition iteration 2 — Extract timeline rejection policy

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: route-end buffer policy, rejection categorization, gate breakdown and per-route candidate rejection summaries
- New files: `src/modules/itineraries/engines/helpers/timeline-rejection-policy.service.ts`, `test/timeline-rejection-policy.test.ts`

#### Verification

- Original facade: 10,254 → 10,175 lines
- Extracted service: 103 lines
- Rejection-policy tests: PASS, 3/3
- Combined backend focused suite: PASS, 29/29
- Backend build: PASS

#### Compatibility

- `TimelineBuilder` still owns the public build method and returns the same rejection summary shape.
- No controller, route, DTO, response, Prisma query, transaction or frontend change.
- Commit: `api.dvi.travel` `f093f89`.

### Full-decomposition iteration 3 — Extract timeline route policy

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: city normalization, same-city keys, route legs, route-chain matching, movement ordering, carry-forward compatibility and route capacity estimation
- New files: `src/modules/itineraries/engines/helpers/timeline-route-policy.service.ts`, `test/timeline-route-policy.test.ts`

#### Verification

- Original facade: 10,175 → 9,948 lines
- Extracted service: 190 lines
- Route-policy tests: PASS, 3/3
- Combined backend focused suite: PASS, 32/32
- Backend build: PASS

#### Compatibility

- Existing `TimelineBuilder` method signatures and callers remain intact.
- No controller, route, DTO, response, Prisma query, transaction or frontend change.
- Commit: `api.dvi.travel` `c95d4f8`.

### Full-decomposition iteration 4 — Extract timeline anchor policy

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: fixed timeline anchors, real-gap intervals, absolute route time conversion, plan timestamp parsing, same-city continuation context and travel-location classification
- New files: `src/modules/itineraries/engines/helpers/timeline-anchor-policy.service.ts`, `test/timeline-anchor-policy.test.ts`

#### Verification

- Original facade: 9,948 → 9,795 lines
- Extracted service: 148 lines
- Anchor-policy tests: PASS, 3/3
- Combined backend focused suite: PASS, 35/35
- Backend build: PASS

#### Compatibility

- Timeline scheduling remains in the existing facade; only pure anchor calculations moved.
- No controller, route, DTO, response, Prisma query, transaction or frontend change.
- Commit: `api.dvi.travel` `be9e5bc`.

### Full-decomposition iteration 5 — Extract timeline data access

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: route-matrix batching, arrival-hotel marker fallback, date-only normalization and inter-city travel-row distance normalization
- New files: `src/modules/itineraries/engines/helpers/timeline-data-access.service.ts`, `test/timeline-data-access.test.ts`

#### Verification

- Original facade: 9,795 → 9,612 lines
- Extracted service: 184 lines
- Combined focused backend suite: PASS, 31/31 in the tier run
- Backend build: PASS

#### Compatibility

- Existing SQL, Prisma filters, fallback ordering and returned shapes are preserved behind a private service boundary.
- No index, Redis, controller, route, DTO, response or frontend change.
- Commit: `api.dvi.travel` `8f35e2f`.

### Full-decomposition iteration 6 — Extract timeline travel data

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: hotspot and hotel location reads, hotel detail enrichment, stored-location coordinate resolution, pure travel-time calculation and projected arrival-to-destination calculation
- New files: `src/modules/itineraries/engines/helpers/timeline-travel-data.service.ts`, `test/timeline-travel-data.test.ts`
- Shared dependency: the existing `DistanceHelper` instance is passed explicitly so global-settings caching and provider behaviour remain unchanged

#### Verification

- Original facade: 9,612 → 9,374 lines
- Extracted service: 290 lines
- Focused timeline/policy/backend tests: PASS, 34/34
- Backend build: PASS

#### Compatibility and performance evidence

- Existing facade method signatures and call sites remain intact.
- Prisma filters, selected fields, fallback ordering, travel location types and buffer handling were preserved.
- No query rewrite, index mutation or Redis dependency was introduced.
- Endpoint query count, rows examined, payload size and latency remain unmeasured; the new boundary makes those reads attributable for a later profiled tier.
- Commit: `api.dvi.travel` `b331633`.

### Full-decomposition iteration 7 — Extract timeline candidate feasibility

#### Scope

- Original facade: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Responsibility extracted: candidate travel admission, operating-hours checks, wait-until-open handling, route-end return checks, last-route departure deadlines and fixed-anchor gap protection
- New files: `src/modules/itineraries/engines/helpers/timeline-candidate-feasibility.service.ts`, `test/timeline-candidate-feasibility.test.ts`
- Dependencies: explicit operating-hours, slot, anchor and travel-data policies plus the shared `DistanceHelper`

#### Verification

- Original facade: 9,374 → 9,182 lines
- Extracted service: 314 lines
- Focused timeline/policy/backend tests: PASS, 37/37
- Backend build: PASS

#### Compatibility and performance evidence

- Existing rejection reason strings, deadline semantics, wait handling and result fields are preserved.
- The builder remains the compatibility facade; no controller, route, DTO, response or persistence contract changed.
- No query rewrite, index mutation or Redis dependency was introduced.
- Candidate travel and operating-hours calls are now attributable to a focused service for later request-level query/timing instrumentation.
- Commit: `api.dvi.travel` `2bd3a55`.

### Full-decomposition iteration 8 — Extract itinerary guide assignments

#### Scope

- Original facade: `src/modules/itineraries/itineraries.service.ts`
- Responsibility extracted: guide availability, guide assignment projections/options, guide eligibility, date-wise pricebook resolution, pax buckets and GST policy
- New files: `src/modules/itineraries/services/itinerary-guide-assignment.service.ts`, `test/itinerary-guide-assignment.test.ts`
- Module wiring: `ItineraryGuideAssignmentService` is registered by `ItinerariesModule`; the original service remains the compatibility facade

#### Baseline and prioritization

- Target size before tier: 37,224 lines
- Descending-size target order now active: `itineraries.service.ts` → `itinerary-details.service.ts` → `vendors.service.ts` → `hotels.service.ts` → `activities.service.ts` → `locations.service.ts` → `hotspots.service.ts`
- Query count/timing: not measured against a representative endpoint; no performance claim is made

#### Verification

- Original facade: 37,224 → 36,843 lines
- Extracted service: 337 lines
- Guide characterization tests: PASS, 3/3
- Combined focused backend suite: PASS, 40/40
- Backend build: PASS

#### Compatibility and performance evidence

- Existing guide API methods, validation messages, ordering, language/slot mappings, date handling, pricebook filters and GST calculations remain behind the facade.
- No query shape, index, Redis, route, DTO or response contract changed.
- Guide Prisma reads are now attributable to a dedicated boundary for later query-count/payload measurement.
- Commit: `api.dvi.travel` `a5a46e0`.

#### Verification

- Read-only database audit: PASS; 182 tables, 2,288 index definitions, Performance Schema enabled
- No DDL/DML executed

#### Result

- Index rollback SQL and approval gates are present without speculative production changes.

### Cycle 10 — Bounded API contract smoke

#### Scope

- Existing harness: `scripts/test-api-endpoints.js`
- Workflows: Swagger docs, authentication, authenticated dashboard read, GraphQL authorization and authenticated dashboard summary
- Write scope: no itinerary or booking mutation; full endpoint sweep remained disabled

#### Verification

- API smoke: PASS, 5/5
- Swagger docs: PASS
- Auth login: PASS, HTTP 201
- Authenticated REST dashboard: PASS, HTTP 200
- GraphQL unauthorized and authenticated checks: PASS

#### Result

- A bounded API smoke result now covers the baseline’s REST, GraphQL and Swagger runtime surfaces without claiming full endpoint coverage.

### Cycle 11 — Extract location geo policy

#### Scope

- Original file: `src/modules/locations/locations.service.ts`
- Extracted responsibility: coordinate parsing, location-name normalization, case-insensitive deduplication, duration text and haversine distance policy
- New files: `src/modules/locations/services/location-geo-policy.service.ts`, `test/location-geo-policy.test.ts`
- Endpoint/UI workflow: locations CRUD, autosuggest and route-distance calculations; API contracts unchanged
- Tables: none directly; existing Prisma reads/writes remain in `LocationsService`

#### Change

- Moved pure geo/name policy behind `LocationGeoPolicyService`.
- Kept `LocationsService` as the compatibility facade and registered the policy provider in `LocationsModule`.
- No query, transaction, DTO, route, response, index or frontend change.

#### Verification

- Location geo policy tests: PASS, 3/3
- Combined focused backend suite: PASS, 23/23
- Backend build: PASS

#### Result

- The Locations service has a narrow pure-policy seam for future route-distance characterization.
- Commit: `api.dvi.travel` `7a4966a`.

### Cycle 6 — Itinerary-details utility characterization (frontend)

#### Scope

- Repository: `dvi_frontend`
- New file: `src/test/itinerary-details.utils.test.ts`
- Workflow: active `/itinerary-details/:id` utility paths for preview resolution, hotspot availability, timeline filtering and Fit Here status mapping

#### Change

- Added four focused pure-function characterization tests.
- No production component, hook, API call, route or response contract changed.

#### Verification

- Focused utility tests: PASS, 4/4
- Frontend full unit suite: PASS, 13/13
- Frontend build: PASS

#### Result

- Frontend test coverage now protects the existing itinerary-details utility seams before further component/hook extraction.
- Commit: `dvi_frontend` `8fc7342`.

### Cycle 7 — Read-only database evidence baseline

#### Scope

- New script: `scripts/audit-database-performance.ts`
- New artifact: `docs/performance/database-audit-baseline.json`
- Workflow: database/schema evidence only; no endpoint or persistence behavior changed

#### Change

- Added a repeatable read-only audit over `information_schema` and available `performance_schema` counters.
- Added explicit interpretation flags preventing estimated table rows or audit-query timings from being treated as endpoint latency.
- No DDL, DML, migration, query rewrite or index mutation.

#### Verification

- Read-only audit: PASS against configured local `dvi_main`; 182 tables, 2,288 index definitions, 0 foreign-key relationships, Performance Schema enabled
- Backend build: PASS

#### Result

- Database optimization remains evidence-gated: no index or query recommendation is retained without a representative endpoint trace and query plan.
- Commit: `api.dvi.travel` `6594900`.

### Cycle 12 â€” Extract itinerary vehicle-build status boundary

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: vehicle-build run IDs, schedule counters, status-table lifecycle, status counts, derived readiness and DB/memory fallback resolution
- New files: `src/modules/itineraries/services/itinerary-vehicle-build-status.service.ts`, `test/itinerary-vehicle-build-status.test.ts`
- Workflow: vehicle build status endpoints and the status reads used by synchronous/background vehicle builds

#### Change

- Moved the vehicle-build status repository/state boundary behind `ItineraryVehicleBuildStatusService`.
- Kept `ItinerariesService` as the compatibility facade and retained the existing SQL, status fields, readiness rules, error text and run-ID shape.
- Registered the new provider in `ItinerariesModule`.
- Manual-fit attempt persistence remains in the facade because it is interleaved with this block but has a separate lifecycle.

#### Verification

- Vehicle-build status characterization tests: PASS, 3/3
- Combined focused backend suite: PASS, 43/43
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 36,603 lines after the tier (36,843 before this tier); the extracted service is 316 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `c1ad1fc`.

### Cycle 13 â€” Extract itinerary vehicle-build orchestration

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: vehicle build stages, timeout handling, permit sync, retry policy, plan vehicle context, background trigger and lowest-cost active vendor selection
- New files: `src/modules/itineraries/services/itinerary-vehicle-build.service.ts`, `test/itinerary-vehicle-build.test.ts`
- Workflow: vehicle permit/build endpoints and post-plan-save vehicle builds

#### Change

- Moved vehicle-build orchestration behind `ItineraryVehicleBuildService`.
- Preserved the existing stage names/timeouts, transaction options, retry messages, active/rate-available vendor filtering, tie-break ordering and background error handling.
- Kept `ItinerariesService.selectVehicleVendor` as the facade-owned write boundary and connected it through an explicit callback; no circular service dependency was introduced.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Vehicle-build boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 45/45
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 36,115 lines after the tier; `ItineraryVehicleBuildService` is 473 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `4b35e4a`.

### Cycle 14 â€” Extract itinerary plan persistence and reusable templates

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: create/update plan transaction, route/via-route/permit/traveller/hotel/hotspot rebuild sequencing, parking rebuild, post-save vehicle trigger, reusable-template save/lookup/snapshot persistence
- New files: `src/modules/itineraries/services/itinerary-plan-persistence.service.ts`, `test/itinerary-plan-persistence.test.ts`
- Workflow: basic itinerary save/update and reusable-template endpoints

#### Change

- Moved the contiguous plan-save/template boundary behind `ItineraryPlanPersistenceService`.
- Preserved the transaction timeout/max-wait, cleanup ordering, route and permit sequencing, validation/error handling, background vehicle trigger, optimizer/template best-effort handling and response envelope.
- Kept route optimization, same-city optimization and plan-edit lookup behind explicit callbacks to the existing facade-owned boundaries.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Plan-persistence boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 47/47
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 35,433 lines after the tier; `ItineraryPlanPersistenceService` is 821 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `33d68d7`.

### Cycle 15 â€” Extract itinerary activity workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: add activity, preview activity timing/cascade, delete activity, and all-hotspots activity preview workflows
- New files: `src/modules/itineraries/services/itinerary-activity-workflow.service.ts`, `test/itinerary-activity-workflow.test.ts`
- Workflow: activity add/preview/delete endpoints; smart activity preview remains in the next boundary

#### Change

- Moved the contiguous activity workflow behind `ItineraryActivityWorkflowService`.
- Preserved activity lookup, duplicate checks, pricing delegation, conflict/warning responses, cascade calculations, transaction timeouts, deletion rebuild and preview ordering.
- Kept existing timing, pricing and impact policies behind explicit callbacks to avoid moving unrelated helper state.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Activity workflow boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 49/49
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 34,784 lines after the tier; `ItineraryActivityWorkflowService` is 750 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `be8dab5`.

### Cycle 16 â€” Extract smart itinerary activity engine

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: smart activity preview/apply-preview, hotspot-gap movement, anchored local rebuild, preview timeline assembly and smart activity insertion
- New files: `src/modules/itineraries/services/itinerary-smart-activity.service.ts`, `test/itinerary-smart-activity.test.ts`
- Workflow: smart activity preview and insert endpoints

#### Change

- Moved the tightly coupled smart-activity transaction engine behind `ItinerarySmartActivityService`.
- Preserved gap validation, priority-removal confirmation, rollback-preview behavior, hotspot ordering, local rebuild/deletion rules, timeline response shape and insertion transaction timeout.
- Kept time/conflict formatting policies behind explicit callbacks and retained `ItinerariesService.getHotspotDurationMinutes` because other facade workflows still use that helper.
- Rebuilt the extracted source from bounded committed-source chunks after a verification-time truncation was detected; no corrupted intermediate file was committed.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Smart activity boundary tests: PASS, 1/1
- Combined focused backend suite: PASS, 50/50
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 33,522 lines after the tier; `ItinerarySmartActivityService` is 1,352 lines because it retains a cohesive transaction/rebuild engine.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `b0476eb`.

### Cycle 17 — Extract itinerary hotspot workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: route hotspot availability, anchor-aware availability, hotspot add and hotspot preview workflows
- New files: `src/modules/itineraries/services/itinerary-hotspot-workflow.service.ts`, `test/itinerary-hotspot-workflow.test.ts`
- Workflow: hotspot availability/add/preview endpoints

#### Change

- Moved the contiguous hotspot workflow behind `ItineraryHotspotWorkflowService`.
- Preserved route/location filtering, source/destination classification, ordering/interleaving rules, manual hotspot preview delegation, add persistence and preview response behavior.
- Kept existing shared location/time policy helpers behind explicit callbacks and retained the hotspot engine dependency.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Hotspot workflow boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 51/51
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 32,712 lines after the tier; `ItineraryHotspotWorkflowService` is 891 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `cc01da7`.

### Cycle 18 — Extract itinerary selection and pricing workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: hotel discovery/selection, bulk hotel persistence, vehicle-vendor selection, slab selection/auto-selection and vehicle-pricing rebuilds after hotspot changes
- New files: `src/modules/itineraries/services/itinerary-selection-workflow.service.ts`, `test/itinerary-selection-workflow.test.ts`
- Workflow: hotel selection and vehicle pricing endpoints plus hotspot-triggered vehicle rebuilds

#### Change

- Moved the contiguous hotel and vehicle selection workflow behind `ItinerarySelectionWorkflowService`.
- Preserved Haversine hotel candidate filtering, hotel/room upsert behavior, cache invalidation, active-vendor filtering, rate validation, slab overrides, automatic slab re-selection and assignment restoration after rebuild.
- Registered the new provider in `ItinerariesModule` and retained `ItinerariesService` compatibility wrappers for all controller and internal callers.

#### Verification

- Selection workflow boundary tests: PASS, 3/3
- Combined focused backend suite: PASS, 54/54
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 32,159 lines after the tier; `ItinerarySelectionWorkflowService` is 604 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `71b3ec5`.

### Cycle 19 — Extract itinerary quote context reads

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: plan edit reads, customer form projection and wallet balance resolution
- New files: `src/modules/itineraries/services/itinerary-quote-context.service.ts`, `test/itinerary-quote-context.test.ts`
- Workflow: quote edit, customer form and wallet endpoints

#### Change

- Moved the contiguous quote-context read workflows behind `ItineraryQuoteContextService`.
- Preserved route/via/vehicle/traveller ordering, agent/city/company display formatting, wallet stored-balance and cash-ledger fallback arithmetic, and validation messages.
- Registered the new provider in `ItinerariesModule`; confirmation transaction and hotel booking orchestration remain in `ItinerariesService`.

#### Verification

- Quote-context boundary tests: PASS, 3/3
- Combined focused backend suite: PASS, 57/57
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 31,955 lines after the tier; `ItineraryQuoteContextService` is 232 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `b26ce39`.

### Cycle 20 — Extract itinerary confirmation workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: quotation confirmation transaction, supplier-booking normalization and confirmation persistence preparation
- New files: `src/modules/itineraries/services/itinerary-confirmation.service.ts`, `test/itinerary-confirmation.test.ts`
- Workflow: quotation confirmation endpoint

#### Change

- Moved the contiguous confirmation transaction and its supplier-stay normalization helpers behind `ItineraryConfirmationService`.
- Preserved wallet deduction timing, existing-confirmation reuse, hotel restriction validation, confirmation parent/guest/child/infant persistence, draft copy ordering and provisional status behavior for supplier bookings.
- Kept facade-owned hotel-draft synchronization, wallet/date callbacks and post-confirmation provider booking orchestration behind explicit compatibility adapters.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Confirmation boundary tests: PASS, 3/3
- Combined focused backend suite: PASS, 60/60
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 31,061 lines after the tier; `ItineraryConfirmationService` is 980 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `7d63d1c`.

### Cycle 21 — Extract hotel confirmation support

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: selected-hotel draft synchronization, confirmation financial finalization and already-successful supplier-booking filtering
- New files: `src/modules/itineraries/services/itinerary-hotel-confirmation-support.service.ts`, `test/itinerary-hotel-confirmation-support.test.ts`
- Workflow: hotel confirmation support used by confirmation and provider-booking follow-up paths

#### Change

- Moved the contiguous hotel-confirmation support workflows behind `ItineraryHotelConfirmationSupportService`.
- Preserved multi-night draft expansion, stale-row deactivation, room/amenity synchronization, financial idempotency, provider confirmation lookup and pending-booking filtering.
- Kept provider normalization/key policies and wallet resolution behind explicit callbacks; external provider API calls remain outside this service.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Hotel confirmation support boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 62/62
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 30,356 lines after the tier; `ItineraryHotelConfirmationSupportService` is 786 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `5e35b9d`.

### Cycle 22 — Extract itinerary hotel prebook workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: TBO hotel prebook request/response normalization and fresh booking-code resolution
- New files: `src/modules/itineraries/services/itinerary-hotel-prebook.service.ts`, `test/itinerary-hotel-prebook.test.ts`
- Workflow: hotel prebook endpoint

#### Change

- Moved the contiguous hotel prebook workflow and booking-code refresh fallback behind `ItineraryHotelPrebookService`.
- Preserved supplier-bookable filtering, empty/external-stay responses, TBO prebook selection payload, room/promotions/policies/inclusions extraction, supplement normalization and final-price aggregation.
- Kept generic normalization and provider filtering behind explicit callbacks and retained TBO/room-details dependencies.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Hotel prebook boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 64/64
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 29,920 lines after the tier; `ItineraryHotelPrebookService` is 500 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and endpoint latency remain unmeasured.
- Commit: `api.dvi.travel` `d26ddbd`.

### Cycle 23 — Extract hotel booking fulfillment

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: post-confirmation supplier booking dispatch, duplicate-success filtering, provider result aggregation and final financial status updates
- New files: `src/modules/itineraries/services/itinerary-hotel-booking-fulfillment.service.ts`, `test/itinerary-hotel-booking-fulfillment.test.ts`
- Workflow: provider hotel booking follow-up after quotation confirmation

#### Change

- Moved the contiguous provider fulfillment workflow behind `ItineraryHotelBookingFulfillmentService`.
- Preserved provider partitioning, already-confirmed filtering, supplier payload mapping, result aggregation, finalization callbacks and external/self-arranged-only response behavior.
- Kept provider APIs outside database transactions and retained the existing facade compatibility wrapper.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Hotel booking fulfillment boundary tests: PASS, 1/1
- Combined focused backend suite: PASS, 65/65
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 29,565 lines after the tier; `ItineraryHotelBookingFulfillmentService` is 441 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Provider latency, retry volume, query count, rows examined and payload size remain unmeasured.
- Commit: `api.dvi.travel` `81c8cd2`.

### Cycle 24 — Extract confirmed-plan copy workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: transaction-scoped draft-to-confirmed copying of itinerary child rows
- New files: `src/modules/itineraries/services/itinerary-confirmed-plan-copy.service.ts`, `test/itinerary-confirmed-plan-copy.test.ts`
- Workflow: confirmation transaction child-row copy

#### Change

- Moved the contiguous draft-to-confirmed copy workflow behind `ItineraryConfirmedPlanCopyService`.
- Preserved vehicle, route, via-route, hotel, activity, guide, vendor-eligibility, vehicle-detail and permit-charge copy ordering and optional hotel filtering.
- Passed the transaction client explicitly and retained the facade compatibility wrapper.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Confirmed-plan copy boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 66/66
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 29,089 lines after the tier; `ItineraryConfirmedPlanCopyService` is 504 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Copied row counts, transaction wait, lock time and payload size remain unmeasured.
- Commit: `api.dvi.travel` `f3ed67c`.

### Cycle 25 — Extract itinerary cancellation workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: cancellation validation, transaction persistence, child cleanup, supplier cancellation dispatch, audit logging and notifications
- New files: `src/modules/itineraries/services/itinerary-cancellation.service.ts`, `test/itinerary-cancellation.test.ts`
- Workflow: itinerary cancellation endpoint

#### Change

- Moved the contiguous cancellation workflow behind `ItineraryCancellationService`.
- Preserved required-field and confirmed-plan checks, duplicate cancellation protection, selective child cleanup, cancellation charge/refund calculations, provider cancellation dispatch, audit logging and notifications.
- Retained the facade compatibility wrapper and registered the new provider in `ItinerariesModule`.

#### Verification

- Cancellation boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 68/68
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 28,519 lines after the tier; `ItineraryCancellationService` is 602 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, provider latency and transaction wait remain unmeasured.
- Commit: `api.dvi.travel` `f818293`.

### Cycle 26 — Extract itinerary listing and filter workflows

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: agent/location filters and confirmed, cancelled and accounts itinerary listing reads
- New files: `src/modules/itineraries/services/itinerary-listing.service.ts`, `test/itinerary-listing.test.ts`
- Workflow: itinerary listing/filter endpoints

#### Change

- Moved the contiguous listing/filter read workflows behind `ItineraryListingService`.
- Preserved role scoping, date parsing, guide/vendor constraints, global search, pagination/count behavior and response projections.
- Registered the new provider in `ItinerariesModule` and retained compatibility wrappers in `ItinerariesService`.

#### Verification

- Listing boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 70/70
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 27,963 lines after the tier; `ItineraryListingService` is 615 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and listing latency remain unmeasured.
- Commit: `api.dvi.travel` `b285309`.

### Cycle 27 — Extract itinerary voucher read workflows

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: hotel and transport voucher read projections, labels and formatting
- New files: `src/modules/itineraries/services/itinerary-voucher-read.service.ts`, `test/itinerary-voucher-read.test.ts`
- Workflow: hotel and transport voucher endpoints

#### Change

- Moved the contiguous voucher read workflows behind `ItineraryVoucherReadService`.
- Preserved hotel/room/voucher/cancellation-policy reads, vehicle/vendor/gallery reads, route/hotspot reads, transport-cost queries and date/location/passenger projections.
- Kept existing formatting policies behind explicit callbacks and retained missing-plan validation.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Voucher boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 70/70
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 27,228 lines after the tier; `ItineraryVoucherReadService` is 810 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, payload size and voucher latency remain unmeasured.
- Commit: `api.dvi.travel` `bb8d421`.

### Cycle 28 — Extract manual hotspot matrix workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: missing manual-hotspot route-matrix construction and concurrency lock
- New files: `src/modules/itineraries/services/itinerary-manual-hotspot-matrix.service.ts`, `test/itinerary-manual-hotspot-matrix.test.ts`
- Workflow: manual hotspot matrix-build endpoint

#### Change

- Moved the matrix-build workflow behind `ItineraryManualHotspotMatrixService`.
- Preserved positive-ID validation, lock contention response, source/destination city gating, OSRM configuration, helper invocation and result-code semantics.
- Kept city/location normalization behind explicit callbacks and registered the new provider in `ItinerariesModule`.

#### Verification

- Manual matrix boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 74/74
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 27,086 lines after the tier; `ItineraryManualHotspotMatrixService` is 190 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- External routing latency, matrix row volume, failure rate and lock contention remain unmeasured.
- Commit: `api.dvi.travel` `2bc6f75`.

### Cycle 29 — Extract manual hotspot preview and Fit Here workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-hotspot preview/batch preview, snapshot rollback, preview caches, Fit Here preview/auto-fit and Fit Here confirmation entry points
- New files: `src/modules/itineraries/services/itinerary-manual-hotspot-preview.service.ts`, `test/itinerary-manual-hotspot-preview.test.ts`
- Workflow: manual hotspot preview and Fit Here endpoints

#### Change

- Moved the contiguous preview/Fit Here boundary behind `ItineraryManualHotspotPreviewService`.
- Preserved preview rollback behavior, retry policy callbacks, snapshot restore, exact-anchor cache behavior, timeline fingerprinting and controller-compatible Fit Here entry points.
- Moved preview cache state into the new service and retained facade adapters for later manual-fit helpers.
- Registered the new provider in `ItinerariesModule`.

#### Verification

- Manual preview boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 76/76
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 26,618 lines after the tier; `ItineraryManualHotspotPreviewService` is 591 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Preview transaction duration, rollback cost, cache hit rate and payload size remain unmeasured.
- Commit: `api.dvi.travel` `b3a8124`.

### Cycle 30 — Extract manual hotspot mutation workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-hotspot add and batch-apply orchestration
- New files: `src/modules/itineraries/services/itinerary-manual-hotspot-mutation.service.ts`, `test/itinerary-manual-hotspot-mutation.test.ts`
- Workflow: manual hotspot add and batch apply endpoints

#### Change

- Moved the contiguous add/batch mutation workflow behind `ItineraryManualHotspotMutationService`.
- Preserved existing add response projection, duplicate detection, batch transaction, stale-row cleanup, timing calculation, retry policy and vehicle-pricing rebuild callbacks.
- Registered the new provider in `ItinerariesModule` and retained compatibility wrappers.

#### Verification

- Manual mutation boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 77/77
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 26,296 lines after the tier; `ItineraryManualHotspotMutationService` is 402 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Transaction duration, row churn, pricing-rebuild cost and retry count remain unmeasured.
- Commit: `api.dvi.travel` `faba32b`.

### Cycle 31 - Extract manual fit matrix planning

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: detour anchor inference, matrix insertion-gap resolution and low-priority-removal timeline reconstruction
- New files: `src/modules/itineraries/services/itinerary-manual-fit-matrix-planning.service.ts`, `test/itinerary-manual-fit-matrix-planning.test.ts`
- Workflow: manual fit matrix planning and timeline reconnection

#### Change

- Moved the contiguous manual-fit matrix planning helpers behind `ItineraryManualFitMatrixPlanningService`.
- Preserved route hotspot ordering, detour-distance comparison, matrix boundary validation, cached-leg fallback, travel relabeling and removed-hotspot sanitization.
- Registered the new provider and retained facade wrappers with explicit timeline/route helper callbacks.

#### Verification

- Manual fit matrix planning boundary tests: PASS, 2/2
- Combined focused backend suite: PASS, 53/53
- Backend build: PASS
- `git diff --check`: PASS
- Full backend suite: 81/87; six unrelated permit-charge parity fixture failures remain because their transaction mock does not provide `dvi_vehicle.findFirst`.

#### Result

- `itineraries.service.ts` measured at 25,649 lines after the tier; `ItineraryManualFitMatrixPlanningService` is 778 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Active-attraction selectivity, route-leg count, timeline row volume, reconstruction CPU and latency remain unmeasured.
- Commit: `api.dvi.travel` `d21471b`.

### Cycle 32 - Extract exact-anchor sequential rebuild

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: exact-anchor sequential timeline reconstruction after manual-fit removals
- New files: `src/modules/itineraries/services/itinerary-exact-anchor-rebuild.service.ts`, `test/itinerary-exact-anchor-rebuild.test.ts`
- Workflow: Fit Here exact-anchor rebuild and removal rescue

#### Change

- Moved the contiguous exact-anchor rebuild method behind `ItineraryExactAnchorRebuildService`.
- Preserved persisted route-attraction reads, selected-hotspot synthesis, city-direction ordering, travel-replica reuse, operating-window adjustments, hotel reconnection and bounded timeline caching.
- Registered the new provider and retained the compatibility facade with explicit transaction and policy callbacks.

#### Verification

- Exact-anchor rebuild boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 54/54
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 24,815 lines after the tier; `ItineraryExactAnchorRebuildService` is 978 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Transaction read fan-out, route-leg volume, cache hit rate, rebuild CPU and latency remain unmeasured.
- Commit: `api.dvi.travel` `8761ec9`.

### Cycle 33 - Extract low-priority removal planning

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: matrix-overflow removal planning, active-route evidence and removal-attempt snapshot helpers
- New files: `src/modules/itineraries/services/itinerary-low-priority-removal.service.ts`, `test/itinerary-low-priority-removal.test.ts`
- Workflow: manual-fit overflow resolution and lower-priority removal confirmation

#### Change

- Moved the contiguous low-priority removal boundary behind `ItineraryLowPriorityRemovalService`.
- Preserved candidate priority ordering, protected manual hotspots, preselected-plan validation, bounded combination search, greedy fallback, route evidence filtering and snapshot helper behavior.
- Registered the new provider and retained facade adapters for the following progressive-removal workflow.

#### Verification

- Low-priority removal boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 55/55
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 24,121 lines after the tier; `ItineraryLowPriorityRemovalService` is 819 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Candidate volume, simulation count, transaction duration, snapshot payload size and latency remain unmeasured.
- Commit: `api.dvi.travel` `ba7eb53`.

### Cycle 34 - Extract matrix-safe manual insertion

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: matrix-safe manual-hotspot insertion transaction, route-local persistence and post-apply validation
- New files: `src/modules/itineraries/services/itinerary-matrix-safe-insertion.service.ts`, `test/itinerary-matrix-safe-insertion.test.ts`
- Workflow: manual hotspot matrix-safe apply

#### Change

- Moved the contiguous matrix-safe insertion transaction behind `ItineraryMatrixSafeInsertionService`.
- Preserved active-row checks, single-hotspot validation, matrix/exact-anchor slot gating, timing persistence, removal application, rebuild/enrichment and strict post-apply assertions.
- Registered the new provider and retained compatibility wrappers with explicit transaction and policy callbacks.

#### Verification

- Matrix-safe insertion boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 56/56
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 22,867 lines after the tier; `ItineraryMatrixSafeInsertionService` is 1,315 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Active-row selectivity, route-hotspot row churn, transaction wait, rebuild volume and latency remain unmeasured.
- Commit: `api.dvi.travel` `62b04ee`.

### Cycle 35 - Extract preview timeline application

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual insertion projection, destination-side pruning, pivot backtracking cleanup and baseline preview rebuilding
- New files: `src/modules/itineraries/services/itinerary-preview-timeline-application.service.ts`, `test/itinerary-preview-timeline-application.test.ts`
- Workflow: manual-fit preview timeline assembly

#### Change

- Moved the contiguous preview-timeline application helpers behind `ItineraryPreviewTimelineApplicationService`.
- Preserved matrix split-row handling, destination-side row pruning, city-direction ordering, operating-window timing, duration fallbacks and preview timeline shapes.
- Registered the new provider and retained facade wrappers with explicit policy callbacks.

#### Verification

- Preview timeline application boundary test: PASS, 1/1
- Combined focused backend suite: PASS, 57/57
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 22,270 lines after the tier; `ItineraryPreviewTimelineApplicationService` is 655 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Timeline row volume, transformation CPU, payload size, cache effects and latency remain unmeasured.
- Commit: `api.dvi.travel` `3241ea7`.

### Cycle 36 - Extract route-leg cache and provider fallback

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: OSRM leg runtime cache, TTL/key normalization, reverse-leg reuse, stored-coordinate reads and distance/duration fallback helpers
- New files: `src/modules/itineraries/services/itinerary-route-leg-cache.service.ts`, `test/itinerary-route-leg-cache.test.ts`
- Workflow: route-leg resolution used by manual matrix and preview/rebuild paths

#### Change

- Moved the contiguous route-leg/cache boundary behind `ItineraryRouteLegCacheService`.
- Preserved runtime cache freshness, direct/reverse geometry behavior, endpoint-coordinate lookup, OSRM fallback, route-matrix leg normalization and conservative duration/distance fallbacks.
- Registered the provider and retained facade adapters with the existing route-geometry callback.

#### Verification

- Route-leg cache characterization tests: PASS, 2/2
- Combined focused backend suite: PASS, 59/59
- Backend build: PASS
- `git diff --check`: PASS before documentation changes

#### Result

- `itineraries.service.ts` measured at 22,058 lines after the tier; `ItineraryRouteLegCacheService` is 263 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Cache hit/miss/expiry, provider latency, route-leg volume, geometry payload size and process memory remain unmeasured.
- Implementation commit: `api.dvi.travel` `cde303a`.

### Cycle 37 - Extract manual-hotspot batch transaction workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-hotspot batch transaction, matrix-fit scheduling, preview reconstruction, priority-removal rescue and final response assembly
- New files: `src/modules/itineraries/services/itinerary-manual-hotspot-batch.service.ts`, `test/itinerary-manual-hotspot-batch.test.ts`
- Workflow: manual-hotspot preview/apply batch orchestration

#### Change

- Moved the contiguous manual-hotspot batch boundary behind `ItineraryManualHotspotBatchService`.
- Preserved route/hotspot validation, matrix-slot selection, adaptive scheduling, transaction rollback, exact-anchor and destination-side rescue, opening-hours handling, response projections and persistence-row enrichment.
- Registered the provider and routed existing preview/mutation callers through the new service with explicit policy callbacks.

#### Verification

- Manual-hotspot batch characterization tests: PASS, 2/2
- Combined focused backend suite: PASS, 61/61
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 19,183 lines after the tier; `ItineraryManualHotspotBatchService` is 2,967 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Transaction duration, row churn, matrix/OSRM callback volume, adaptive simulation CPU, rollback frequency, payload size and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `f2c914d`.

### Cycle 38 - Extract manual insertion-fit workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual insertion-fit reads, city-endpoint and single-hotspot slot selection, route-between-map ranking, destination-hotel decisions and timing-aware matrix metadata
- New files: `src/modules/itineraries/services/itinerary-manual-insertion-fit.service.ts`, `test/itinerary-manual-insertion-fit.test.ts`
- Workflow: manual-hotspot fit preview and batch slot selection

#### Change

- Moved the contiguous insertion-fit boundary behind `ItineraryManualInsertionFitService`.
- Preserved route/location/hotspot reads, raw matrix query filters, city-endpoint and destination-side handling, route-fit ranking, timing relaxation and response metadata.
- Registered the provider and routed the batch workflow through the new service with explicit callbacks.

#### Verification

- Manual insertion-fit characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 62/62
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 16,987 lines after the tier; `ItineraryManualInsertionFitService` is 2,254 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Raw-query latency, rows examined, matrix volume, OSRM callback volume, fallback frequency, payload size and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `d52c60f`.

### Cycle 39 - Extract progressive priority-removal planning

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: progressive same-route candidate audit, priority protection, timing evaluation, exact-anchor rescue and ordered simulation attempts
- New files: `src/modules/itineraries/services/itinerary-progressive-priority-removal.service.ts`, `test/itinerary-progressive-priority-removal.test.ts`
- Workflow: manual-fit overflow and selected-closing priority-removal planning

#### Change

- Moved the contiguous progressive-removal boundary behind `ItineraryProgressivePriorityRemovalService`.
- Preserved active-route reads, same-route candidate filtering, priority ordering, exact-anchor direction rules, operating-hours evaluation, snapshot/display validation and final response metadata.
- Registered the provider and routed batch/matrix-safe callers through the new service with explicit callbacks.

#### Verification

- Progressive priority-removal characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 63/63
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 15,605 lines after the tier; `ItineraryProgressivePriorityRemovalService` is 1,437 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Candidate volume, simulation CPU, rebuild rows, snapshot payload, transaction duration, rollback rate and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `d312d7d`.

### Cycle 40 - Extract adaptive manual-hotspot set insertion

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: adaptive manual-hotspot set insertion, optimizer sequencing, optional/P3/protected-priority removal and preview simulation
- New files: `src/modules/itineraries/services/itinerary-adaptive-manual-hotspot-insertion.service.ts`, `test/itinerary-adaptive-manual-hotspot-insertion.test.ts`
- Workflow: manual-hotspot batch insertion and adaptive Fit Here rescue

#### Change

- Moved the contiguous adaptive insertion boundary behind `ItineraryAdaptiveManualHotspotInsertionService`.
- Preserved baseline optimizer behavior, removal ordering, exact-anchor handling, preview-only simulation, exclusion writes and confirmation metadata.
- Registered the provider and routed the batch callback through the new service with explicit facade callbacks.

#### Verification

- Adaptive manual-hotspot insertion characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 64/64
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 14,833 lines after the tier; `ItineraryAdaptiveManualHotspotInsertionService` is 815 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Candidate volume, optimizer CPU, rebuild rows, excluded-list write volume, transaction duration, rollback rate and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `c7effd0`.

### Cycle 41 - Extract matrix-rescheduled preview assembly

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: matrix-rescheduled preview assembly, source/anchor/hotel leg reconstruction, timing rescheduling and duplicate-travel cleanup
- New files: `src/modules/itineraries/services/itinerary-matrix-rescheduled-preview.service.ts`, `test/itinerary-matrix-rescheduled-preview.test.ts`
- Workflow: manual-hotspot batch and matrix-safe insertion preview reconstruction

#### Change

- Moved the contiguous 782-line matrix-rescheduled preview boundary behind `ItineraryMatrixRescheduledPreviewService`.
- Preserved baseline merge behavior, source/destination/hotel saved-rule resolution, matrix split-leg ordering, timing labels, duplicate-travel cleanup and final arrival metadata.
- Registered the provider and routed matrix-safe and batch preview callbacks through the new service with explicit facade callbacks.

#### Verification

- Matrix-rescheduled preview characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 65/65
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 14,076 lines after the tier; `ItineraryMatrixRescheduledPreviewService` is 797 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Callback CPU, route-leg cache hit rate, rebuilt rows, invariant warnings, transaction duration, response size and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `a2f6f92`.

### Cycle 42 - Extract confirmed-itinerary booked-hotel projection

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: confirmed-plan and original-plan reads, provider booking normalization, hotel/master enrichment, room/meal labels and availability metadata
- New files: `src/modules/itineraries/services/itinerary-confirmed-itinerary-details.service.ts`, `test/itinerary-confirmed-itinerary-details.test.ts`
- Workflow: confirmed itinerary details and post-confirmation hotel fulfillment projection

#### Change

- Moved the contiguous confirmed-itinerary details projection behind `ItineraryConfirmedItineraryDetailsService`.
- Preserved provider precedence, confirmed/original plan validation, booking labels, room and meal mapping, voucher cancellation flags and response envelopes.
- Registered the Prisma-backed provider and routed hotel-fulfillment reads through the new service with the existing guide-assignment callback.

#### Verification

- Confirmed-itinerary details characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 66/66
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 13,554 lines after the tier; `ItineraryConfirmedItineraryDetailsService` is 547 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query count, rows examined, provider payload size, callback CPU, transaction duration and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `2f0925d`.

### Cycle 43 - Consolidate matrix baseline merge into preview service

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: matrix baseline/engine preview merge, selected-row preparation, slot validation and finalization handoff
- Updated file: `src/modules/itineraries/services/itinerary-matrix-rescheduled-preview.service.ts`
- Workflow: matrix-safe insertion and manual-hotspot batch preview reconstruction

#### Change

- Moved the 302-line `buildMatrixMergedPreviewTimeline` helper into the existing matrix preview service.
- Preserved no-fit fallback, selected-row projection, source/destination slot replacement and finalization behavior.
- Removed the facade callback seam for this helper so the matrix preview service now owns the complete merge-to-reschedule flow.

#### Verification

- Matrix preview merge characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 67/67
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 13,251 lines after the tier; `ItineraryMatrixRescheduledPreviewService` is 1,100 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Merge CPU, row churn, duration-policy callback volume, response size and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `b4cab2a`.

### Cycle 44 - Extract route timing and rebuild workflow

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: route-time validation, itinerary-boundary recalculation, previous-day billing markers, timeline rebuild and post-rebuild pricing refresh
- New files: `src/modules/itineraries/services/itinerary-route-timing.service.ts`, `test/itinerary-route-timing.test.ts`
- Workflow: route start/end update and plan-wide hotspot rebuild

#### Change

- Moved the contiguous route-timing transaction behind `ItineraryRouteTimingService`.
- Preserved route ownership validation, date-boundary calculations, early-arrival billing decisions, marker writes, hotspot rebuild ordering and post-transaction pricing refresh.
- Registered the Prisma/hotspot-backed provider and routed the controller-facing facade method through it.

#### Verification

- Route timing characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 68/68
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 12,931 lines after the tier; `ItineraryRouteTimingService` is 367 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Transaction duration, lock wait, rebuild rows, marker-row churn, pricing callback CPU and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `2ed84cb`.

### Cycle 45 - Extract manual-fit travel replica display policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-fit travel display normalization, hotel check-in travel insertion, saved-leg fallback, source-to-hotspot resolution and map-table support
- New files: `src/modules/itineraries/services/itinerary-manual-fit-travel-replica.service.ts`, `test/itinerary-manual-fit-travel-replica.test.ts`
- Workflow: exact-anchor/manual-fit travel replica preparation

#### Change

- Moved the contiguous manual-fit travel replica boundary behind `ItineraryManualFitTravelReplicaService`.
- Preserved duration and distance fallback precedence, matrix metadata, OSRM fallback behavior, saved hotel-leg handling and source endpoint resolution.
- Registered explicit callbacks and retained facade adapters for legacy route-helper callers and exact-anchor reconstruction.

#### Verification

- Manual-fit travel replica characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 69/69
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 12,459 lines after the tier; `ItineraryManualFitTravelReplicaService` is 518 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- OSRM calls, saved-leg hit rate, fallback frequency, map-table row churn, callback CPU, payload size and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `f7cea8d`.

### Cycle 46 - Extract manual-fit geometry and endpoint policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: route-coordinate parsing, route projection, OSRM geometry, selected/destination hotel endpoint resolution and hotspot-to-hotel fallback
- New files: `src/modules/itineraries/services/itinerary-manual-fit-geometry.service.ts`, `test/itinerary-manual-fit-geometry.test.ts`
- Workflow: manual-fit route/hotel endpoint and travel-leg resolution

#### Change

- Moved the contiguous manual-fit geometry/endpoint block behind `ItineraryManualFitGeometryService`.
- Preserved coordinate normalization, projection ratio/distance behavior, selected/destination endpoint precedence, OSRM-first routing and Haversine/duration fallback.
- Registered explicit city-classification and duration callbacks and retained facade adapters for existing insertion-fit and route-helper callers.

#### Verification

- Manual-fit geometry characterization test: PASS, 1/1
- Combined focused backend suite: PASS, 70/70
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 12,074 lines after the tier; `ItineraryManualFitGeometryService` is 439 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- OSRM latency/failure rate, endpoint query count, fallback frequency, projection CPU, map-table row churn and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `f578f07`.

### Cycle 47 - Extract timeline candidate and route policy

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: timing-window adapters, slot decisions, carry-forward ordering/merge, route-chain policy, rejection classification and candidate-evaluation reporting
- New files: `src/modules/itineraries/engines/helpers/timeline-candidate-policy.service.ts`, `test/timeline-candidate-policy.test.ts`
- Workflow: timeline candidate prefiltering, scheduling policy and route rejection reporting

#### Change

- Moved the contiguous candidate/timing/route policy block behind `TimelineCandidatePolicyService`.
- Preserved operating-hours and slot behavior, closed-day visit filtering, carry-forward priority ordering, route-chain matching, route-end buffers and rejection summaries.
- Registered the new policy service inside `TimelineBuilder` and retained facade adapters for the main orchestrator.

#### Verification

- Timeline candidate-policy characterization test: PASS, 1/1
- Combined focused backend/timeline suite: PASS, 95/95
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 8,826 lines after the tier; `TimelineCandidatePolicyService` is 468 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Candidate volume, policy CPU, trace writes, route rebuild rows and latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `104da30`.

### Cycle 48 - Extract timeline input loading

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: plan, route, active-hotspot and active-timing reads plus timing-map construction
- New characterization coverage: `test/timeline-data-access.test.ts`
- Workflow: timeline build input preload and all-days timing lookup preparation

#### Change

- Moved the read-only input-loading seam behind `TimelineDataAccessService`.
- Preserved active predicates, route ordering, query order, all-hotspots-once/all-timings-once behavior and O(1) timing-map grouping.
- Kept global-settings hydration and closed-hotspot policy in the builder because they depend on the builder-owned distance and policy state.

#### Verification

- Timeline data-access characterization test: PASS, 4/4
- Combined focused backend/timeline suite: PASS, 96/96
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 8,794 lines after the tier; `TimelineDataAccessService` is 233 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Query latency, rows examined, timing-map memory, hotspot prefilter volume and end-to-end rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `9207539`.

### Cycle 49 - Extract Day-1 source fallback selection

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: Day-1 source-city priority fallback query, city filter, distance ranking and bounded result projection
- New files: `src/modules/itineraries/engines/helpers/timeline-day1-source-fallback.service.ts`, `test/timeline-day1-source-fallback.test.ts`
- Workflow: arrival-city fallback selection for first-route scheduling

#### Change

- Moved the independent Day-1 source fallback boundary behind `TimelineDay1SourceFallbackService`.
- Preserved active/priority predicates, route-coordinate lookup, source-city matching, Haversine distance multiplier, priority-then-distance ordering, exclusion handling and fallback error behavior.
- Registered explicit city-policy callbacks and retained the builder adapter for existing scheduler callers.

#### Verification

- Day-1 source fallback characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 98/98
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 8,696 lines after the tier; `TimelineDay1SourceFallbackService` is 124 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Fallback query latency, candidate volume, distance CPU, excluded-row volume and first-route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `d94d80b`.

### Cycle 50 - Extract route hotspot selection

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: route context loading, timing-aware candidate bucketing, route-chain matching, distance ranking and final hotspot projection
- New files: `src/modules/itineraries/engines/helpers/timeline-route-hotspot-selection.service.ts`, `test/timeline-route-hotspot-selection.test.ts`
- Workflow: route-local hotspot candidate selection before timeline scheduling

#### Change

- Moved the contiguous route-hotspot selection algorithm behind `TimelineRouteHotspotSelectionService`.
- Preserved source/en-route/via/destination bucket precedence, direct-route and via-route suppression, route-specific matching, timing reads, excluded-hotspot handling, distance fallback, de-duplication and final metadata.
- Registered explicit city, route, coordinate, distance and logging callbacks while retaining the builder adapter for all existing callers.

#### Verification

- Route-hotspot selection characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 100/100
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 7,826 lines after the tier; `TimelineRouteHotspotSelectionService` is 932 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Route-selection query latency, timing-row volume, candidate distance calls, bucket volume, trace I/O and rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `90152fe`.

### Cycle 51 - Extract arrival and hotel decisions

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: arrival-window policy evaluation, hotel-first/distance branch, early-arrival clock adjustment, late-arrival/report-cutoff suppression and Day-1 branch logging
- New files: `src/modules/itineraries/engines/helpers/timeline-arrival-hotel-decision.service.ts`, `test/timeline-arrival-hotel-decision.test.ts`
- Workflow: per-route arrival/hotel policy before refreshment and hotspot row assembly

#### Change

- Moved the decision-only arrival/hotel phase behind `TimelineArrivalHotelDecisionService`.
- Preserved arrival policy resolution, previous-day billing state, hotel distance thresholds, early-arrival 08:00/09:00 behavior, report deadlines, late-arrival suppression, houseboat/full-day diagnostics and returned route-clock updates.
- Kept refreshment, hotel travel/check-in rows and hotspot scheduling in `TimelineBuilder`; the service returns explicit flags and adjusted timing state.

#### Verification

- Arrival/hotel decision characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 102/102
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 7,563 lines after the tier; `TimelineArrivalHotelDecisionService` is 421 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Arrival-policy decision latency, hotel-coordinate read latency, distance branch volume, suppression frequency and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `56581e0`.

### Cycle 52 - Extract hotel-first insertion

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: optional hotel travel, check-in, check-in clamp and post-check-in rest-gap row insertion
- New files: `src/modules/itineraries/engines/helpers/timeline-hotel-first-insertion.service.ts`, `test/timeline-hotel-first-insertion.test.ts`
- Workflow: Day-1 same-city hotel-first sequence after arrival/hotel decision evaluation

#### Change

- Moved the transaction-aware hotel-first row sequence behind `TimelineHotelFirstInsertionService`.
- Preserved eligibility gates, hotel travel/check-in builder calls, 14:00 check-in clamp, 60/120-minute rest gap, order increments, booking-rule diagnostics and current-time/location/coordinate updates.
- Kept route cutoff calculation and hotspot scheduling in `TimelineBuilder`.

#### Verification

- Hotel-first insertion characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 104/104
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 7,481 lines after the tier; `TimelineHotelFirstInsertionService` is 155 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Hotel-first invocation rate, hotel-builder/provider latency, inserted-row volume, check-in clamp frequency and rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `1a13e34`.

### Cycle 53 - Extract non-hotel sightseeing cutoff

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: route-end minus intercity travel/buffer cutoff calculation and formatted cutoff projection
- New files: `src/modules/itineraries/engines/helpers/timeline-non-hotel-cutoff.service.ts`, `test/timeline-non-hotel-cutoff.test.ts`
- Workflow: latest allowable non-hotel sightseeing end before route hotspot selection

#### Change

- Moved the distance-backed cutoff calculation behind `TimelineNonHotelCutoffService`.
- Preserved direct intercity and last-route bypasses, travel-location type, coordinate fallback, buffer subtraction, non-negative clamp and HH:MM:SS formatting.
- Kept the returned cutoff values as explicit builder locals used by later candidate feasibility checks.

#### Verification

- Non-hotel cutoff characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 106/106
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 7,453 lines after the tier; `TimelineNonHotelCutoffService` is 69 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Cutoff invocation rate, distance-provider latency, travel/buffer data freshness and candidate-window impact remain unmeasured.
- Implementation commit: `api.dvi.travel` `425567a`.

### Cycle 54 - Extract route-hotspot planning

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: route-hotspot selection planning, via-route classification, Day-1 fallback selection, destination reservation guards and carry-forward expiry
- New files: `src/modules/itineraries/engines/helpers/timeline-route-hotspot-planning.service.ts`, `test/timeline-route-hotspot-planning.test.ts`
- Workflow: route-level policy and selection preparation before closed-day filtering and timeline row assembly

#### Change

- Moved the route-hotspot planning branch behind `TimelineRouteHotspotPlanningService`.
- Preserved active via-route reads, direct/intercity classification, Day-1 source fallback, deterministic zero-priority ordering, destination reservation diagnostics, same-city carry-forward expiry and returned orchestration flags.
- Kept closed-day filtering, candidate admission, travel rows, persistence and final timeline assembly in `TimelineBuilder`.

#### Verification

- Route-hotspot planning characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 109/109
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 7,172 lines after the tier; `TimelineRouteHotspotPlanningService` is 412 lines.
- Builder-local Prisma call matches decreased from 12 to 11; the extracted planner retains the existing via-route read and transaction ownership.
- No query shape, index, Redis, DTO, route or response contract changed.
- Planning invocation rate, via-route query latency, candidate/fallback volume, carry-forward expiry frequency, reservation selectivity and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `005eaef`.

### Cycle 55 - Extract manual/same-city placement ordering

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: route-scoped preview membership, persisted route-order application, desired same-city movable ordering and manual hotspot merge
- New files: `src/modules/itineraries/engines/helpers/timeline-manual-placement-ordering.service.ts`, `test/timeline-manual-placement-ordering.test.ts`
- Workflow: selected-hotspot normalization after policy filtering and before reservation/scheduling evaluation

#### Change

- Moved route-scoped filtering and manual/same-city placement ordering behind `TimelineManualPlacementOrderingService`.
- Preserved sibling-route isolation, existing order precedence, desired movable order and adjacency metadata, manual placeholder merge, deterministic tie ordering and booking-rule diagnostics.
- Returned the ordering maps still required by later scheduling logic; timeline feasibility, travel rows and persistence remain in `TimelineBuilder`.

#### Verification

- Manual placement ordering characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 112/112
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,995 lines after the tier; `TimelineManualPlacementOrderingService` is 210 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Placement invocation rate, scoped-preview reduction, manual-row volume, ordering CPU and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `39afb12`.

### Cycle 56 - Extract destination-loopback reservation policy

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: destination reservation feasibility, destination-bucket filtering, source fallback, empty-route rescue and reservation diagnostics
- New files: `src/modules/itineraries/engines/helpers/timeline-destination-reservation.service.ts`, `test/timeline-destination-reservation.test.ts`
- Workflow: selected-hotspot reservation policy before explicit via/direct source cleanup and carry-forward attachment

#### Change

- Moved destination-loopback reservation and source-city rescue behind `TimelineDestinationReservationService`.
- Preserved next-route candidate availability checks, capacity-based minimums, destination filtering, source fallback matching, empty-route rescue, deterministic de-duplication and booking-rule diagnostics.
- Kept explicit via/direct cleanup, carry-forward merging, matrix augmentation and timeline scheduling in `TimelineBuilder`.

#### Verification

- Destination reservation characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 115/115
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,754 lines after the tier; `TimelineDestinationReservationService` is 317 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Reservation eligibility frequency, next-route candidate volume, fallback/rescue frequency, de-duplication CPU and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `5dd6ee4`.

### Cycle 57 - Extract carry-forward attachment

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: source-fallback-only classification and same-city carry-forward attachment
- New files: `src/modules/itineraries/engines/helpers/timeline-carry-forward-attachment.service.ts`, `test/timeline-carry-forward-attachment.test.ts`
- Workflow: selected-hotspot post-processing immediately before matrix-assisted augmentation

#### Change

- Moved carry-forward attachment and source-fallback classification behind `TimelineCarryForwardAttachmentService`.
- Preserved sightseeing suppression, same-city continuation gating, merge callback arguments, attached-hotspot diagnostics and the scheduler-facing fallback flag.
- Kept matrix augmentation, candidate feasibility and timeline row scheduling in `TimelineBuilder`.

#### Verification

- Carry-forward attachment characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 118/118
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,698 lines after the tier; `TimelineCarryForwardAttachmentService` is 66 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Carry-forward invocation rate, queue size, merge de-duplication work, fallback-only frequency and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `c18259b`.

### Cycle 58 - Extract matrix-assisted autobuild

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: feature-flagged between-hotspot matrix reads, route-fit filtering, matrix scoring, timing admission and candidate merge
- New files: `src/modules/itineraries/engines/helpers/timeline-matrix-autobuild.service.ts`, `test/timeline-matrix-autobuild.test.ts`
- Workflow: optional matrix augmentation after carry-forward attachment and before candidate reordering

#### Change

- Moved matrix-assisted autobuild behind `TimelineMatrixAutobuildService`.
- Preserved feature-flag behavior, route-hotspot ordering read, between-map lookup, corridor ownership checks, excluded/already-planned/duplicate guards, matrix score metadata, route-end/timing gates, logging and candidate append order.
- Kept candidate reordering, feasibility scheduling, travel rows and persistence in `TimelineBuilder`.

#### Verification

- Matrix autobuild characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 120/120
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,535 lines after the tier; `TimelineMatrixAutobuildService` is 234 lines.
- Builder-local static Prisma call matches decreased from 11 to 10; the extracted service retains the existing route-hotspot read and transaction ownership.
- No query shape, index, Redis, DTO, route or response contract changed.
- Matrix flag frequency, route-attraction row volume, between-map latency, candidate rejection/merge volume, timing-check CPU and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `f52f9d3`.

### Cycle 59 - Extract candidate reordering

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: priority/manual protection and matrix-score/distance ordering of selected candidates
- New files: `src/modules/itineraries/engines/helpers/timeline-candidate-reordering.service.ts`, `test/timeline-candidate-reordering.test.ts`
- Workflow: final selected-candidate normalization immediately before Day-1/other-day scheduling loops

#### Change

- Moved candidate reordering behind `TimelineCandidateReorderingService`.
- Preserved manual and positive-priority protection, matrix-score descending order, distance tie-breaks, reorder diagnostics and logging-failure behavior.
- Kept route scheduling, operating-hour evaluation, travel rows and persistence in `TimelineBuilder`.

#### Verification

- Candidate reordering characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 123/123
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,516 lines after the tier; `TimelineCandidateReorderingService` is 30 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Candidate bucket volume, sort CPU, matrix-score population, log volume and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `54dacfe`.

### Cycle 60 - Extract Day-1 candidate gate

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: Day-1 strict priority/filler filtering, terminal-arrival source suppression, duplicate protection and candidate rejection diagnostics
- New files: `src/modules/itineraries/engines/helpers/timeline-day1-candidate-gate.service.ts`, `test/timeline-day1-candidate-gate.test.ts`
- Workflow: first gate inside the Day-1 different-city scheduling loop

#### Change

- Moved Day-1 candidate gate decisions behind `TimelineDay1CandidateGateService`.
- Preserved movement-bucket exceptions, priority 0/>3 suppression, terminal source priority-one suppression with later overnight return, duplicate checks and rejection diagnostics.
- Kept cutoff evaluation, hotspot-master reads, travel calculation, operating-hour scheduling and timeline row mutation in `TimelineBuilder`.

#### Verification

- Day-1 candidate gate characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 126/126
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,443 lines after the tier; `TimelineDay1CandidateGateService` is 93 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Day-1 gate invocation rate, rejection distribution, duplicate frequency, evaluation-log volume and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `3694dea`.

### Cycle 61 - Extract Day-1 cutoff/master admission

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: PHP-compatible Day-1 bucket cutoffs and prefetched hotspot-master admission
- New files: `src/modules/itineraries/engines/helpers/timeline-day1-cutoff-master.service.ts`, `test/timeline-day1-cutoff-master.test.ts`
- Workflow: Day-1 candidate admission after strict priority/duplicate gating and before coordinate/travel calculation

#### Change

- Moved source/via/destination cutoff evaluation and missing-master rejection behind `TimelineDay1CutoffMasterService`.
- Preserved 12:00/19:00/21:00 bucket cutoffs, loopback source-cutoff bypass, rejection metadata and the no-database hotspot-map lookup contract.
- Kept coordinate resolution, travel calculation, projected-arrival checks, operating hours and timeline mutation in `TimelineBuilder`.

#### Verification

- Day-1 cutoff/master characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 129/129
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,404 lines after the tier; `TimelineDay1CutoffMasterService` is 66 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Cutoff rejection frequency, bucket distribution, missing-master rate, evaluation-log volume and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `e1ce0e9`.

### Cycle 62 - Extract Day-1 travel projection and route-end admission

#### Scope

- Original file: `src/modules/itineraries/engines/helpers/timeline.builder.ts`
- Extracted responsibility: Day-1 coordinate fallback, travel projection, absolute-time visit calculation and route-end admission
- New files: `src/modules/itineraries/engines/helpers/timeline-day1-travel-projection.service.ts`, `test/timeline-day1-travel-projection.test.ts`
- Workflow: Day-1 travel state after cutoff/master admission and before operating-hours evaluation

#### Change

- Moved source-coordinate fallback, travel-provider invocation, absolute/wrapped visit-time projection, projected destination arrival and last-route deadline rejection behind `TimelineDay1TravelProjectionService`.
- Preserved distance-call counting, PHP trace payload, route-end rejection metadata, callback ordering and absolute-time values consumed by operating-hours and wait scheduling.
- Kept operating-hours checks, wait-until-open policy, timeline row construction and persistence in `TimelineBuilder`.

#### Verification

- Day-1 travel-projection characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 132/132
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `timeline.builder.ts` measured at 6,340 lines after the tier; `TimelineDay1TravelProjectionService` is 141 lines.
- Static Prisma-call matches in the builder remain 10; no query shape, index, Redis, DTO, route or response contract changed.
- Coordinate fallback frequency, travel-provider latency, projected-arrival rejection rate, evaluation-log volume and route rebuild latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `ceb3dd0`.

### Cycle 63 - Extract draft guide-assignment writes

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: draft guide-assignment validation, costing, upsert and slot-cost persistence
- New files: `src/modules/itineraries/services/itinerary-guide-assignment-write.service.ts`, `test/itinerary-guide-assignment-write.test.ts`
- Workflow: guide assignment save/update endpoint after guide availability and cost policy resolution

#### Change

- Moved plan/route validation, guide-cost resolution, draft guide-row create/update, stale slot-cost deletion and route/all-itinerary slot-cost creation behind `ItineraryGuideAssignmentWriteService`.
- Preserved payload normalization, error messages, route-date fallback, per-slot cost resolution, transaction ordering and `{ success, routeGuideId, guideCost }` response shape.
- Kept guide availability/read projections and controller-facing methods on the `ItinerariesService` compatibility facade.

#### Verification

- Draft guide-assignment write characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 134/134
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,852 lines after the tier; `ItineraryGuideAssignmentWriteService` is 235 lines.
- Static DB-call matches in the facade remain 613; no query shape, index, Redis, DTO, route or response contract changed.
- Guide-cost query latency, route-date fan-out, slot-row volume and assignment transaction latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `19d3cee`.

### Cycle 64 - Complete draft guide-assignment write boundary

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: draft guide-assignment deletion and slot-cost cleanup
- Existing service extended: `src/modules/itineraries/services/itinerary-guide-assignment-write.service.ts`
- Workflow: draft guide-assignment delete endpoint

#### Change

- Moved draft slot-cost deletion followed by route-guide deletion behind the existing guide write service.
- Preserved plan/route scoping, validation messages, transaction ordering and `{ success: true }` response shape.

#### Verification

- Draft guide-assignment write characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 135/135
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` remains at 11,822 lines after the tier; the write service now owns the complete draft guide write boundary.
- No query shape, index, Redis, DTO, route or response contract changed.
- Delete frequency, slot-row cleanup volume and transaction latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `8794031`.

### Cycle 65 - Extract confirmed guide assignment projection

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: confirmed guide/slot-cost hydration, draft slot-cost backfill and response projection
- New files: `src/modules/itineraries/services/itinerary-confirmed-guide-assignment.service.ts`, `test/itinerary-confirmed-guide-assignment.test.ts`
- Workflow: confirmed itinerary guide-assignment read path used by confirmed-details projection and cancellation flows

#### Change

- Moved confirmed-plan lookup, deterministic guide/slot/route/master reads, label mapping and slot grouping behind `ItineraryConfirmedGuideAssignmentService`.
- Moved the existing lazy draft-to-confirmed slot-cost backfill into the service while retaining the cancellation caller’s transaction client.
- Preserved missing-plan validation, route-date fallback, language/slot labels, ordering and response fields.

#### Verification

- Confirmed guide projection characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 137/137
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,669 lines after the tier; `ItineraryConfirmedGuideAssignmentService` is 198 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Confirmed-guide read latency, hydration fan-out, draft-slot backfill frequency and payload size remain unmeasured.
- Implementation commit: `api.dvi.travel` `df3e866`.

### Cycle 66 - Extract confirmed guide-slot cancellation

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: confirmed guide-slot cancellation, refund/charge calculation and cancellation-state aggregation
- New files: `src/modules/itineraries/services/itinerary-confirmed-guide-cancellation.service.ts`, `test/itinerary-confirmed-guide-cancellation.test.ts`
- Workflow: confirmed guide-slot cancellation endpoint after confirmed-plan validation and slot-cost hydration

#### Change

- Moved cancellation validation, lazy slot-cost hydration, cancellation-record creation, cancelled guide/slot copies, refund/charge persistence, route/itinerary aggregation and status updates behind `ItineraryConfirmedGuideCancellationService`.
- Preserved cancellation percentage clamping, DVI/guest defect mapping, financial rounding, idempotency conflict, transaction ordering, audit logging and response fields.
- Kept `ItinerariesService` as the controller compatibility facade and retained the existing cancellation audit callback.

#### Verification

- Confirmed guide cancellation characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 139/139
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,333 lines after the tier; `ItineraryConfirmedGuideCancellationService` is 377 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Cancellation transaction latency, aggregate fan-out, route-full cancellation frequency and refund payload size remain unmeasured.
- Implementation commit: `api.dvi.travel` `99e5437`.

### Cycle 67 - Extract manual-fit preview attempt storage

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-fit attempt table setup, raw persistence, validation, cache lookup and deletion
- New files: `src/modules/itineraries/services/itinerary-manual-fit-attempt-store.service.ts`, `test/itinerary-manual-fit-attempt-store.test.ts`
- Workflow: manual-fit preview/confirmation helper attempt lifecycle

#### Change

- Moved table creation, upsert SQL, in-memory cache, stored-payload validation, DB fallback and deletion behind `ItineraryManualFitAttemptStoreService`.
- Preserved SQL statements, attempt identity fields, expiry fallback, cache-before-database behavior and parse-failure diagnostics.
- Kept compatibility wrappers on `ItinerariesService` for the existing manual-fit helper `this` contract.

#### Verification

- Manual-fit attempt-store characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 141/141
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,216 lines after the tier; `ItineraryManualFitAttemptStoreService` is 129 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Table-setup frequency, raw query latency, cache-hit rate, payload size and parse-failure frequency remain unmeasured.
- Implementation commit: `api.dvi.travel` `5bae62f`.

### Cycle 68 - Extract route-hotspot deletion

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: route-hotspot deletion, dependent-row cleanup, exclusion update and downstream rebuild sequencing
- New files: `src/modules/itineraries/services/itinerary-hotspot-deletion.service.ts`, `test/itinerary-hotspot-deletion.test.ts`
- Workflow: route hotspot delete endpoint through full itinerary rebuild and vehicle-pricing refresh

#### Change

- Moved route-hotspot ID/master resolution, activity/timeline cleanup, route exclusion persistence, hotspot rebuild, parking rebuild and vehicle-pricing refresh behind `ItineraryHotspotDeletionService`.
- Preserved fallback identity lookup, dependent-row predicates, 60-second transaction timeout, rebuild order, logging and response metadata.
- Kept `ItinerariesService` as the controller compatibility facade with an explicit pricing callback.

#### Verification

- Route-hotspot deletion characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 143/143
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,086 lines after the tier; `ItineraryHotspotDeletionService` is 166 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Deletion fan-out, rebuild duration, parking refresh duration and vehicle-pricing refresh latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `065f91d`.

### Cycle 69 - Extract activity availability projection

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: activity catalog, time-slot and plan-pricing response projection
- New files: `src/modules/itineraries/services/itinerary-activity-availability.service.ts`, `test/itinerary-activity-availability.test.ts`
- Workflow: available-activities read endpoint before activity mutation workflows

#### Change

- Moved active activity lookup, per-activity time-slot lookup and plan-specific pricing projection behind `ItineraryActivityAvailabilityService`.
- Preserved activity/title ordering, slot ordering, empty-catalog behavior, pricing callback arguments and all response fields.
- Kept mutation and smart-activity workflows unchanged on the `ItinerariesService` facade.

#### Verification

- Activity-availability characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 145/145
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 11,017 lines after the tier; `ItineraryActivityAvailabilityService` is 97 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Activity/slot fan-out, pricing latency, active-row selectivity and response payload size remain unmeasured.
- Implementation commit: `api.dvi.travel` `5d01b54`.

### Cycle 70 - Extract confirmed invoice/pluck-card read projection

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: confirmed itinerary pluck-card and invoice presentation reads
- New files: `src/modules/itineraries/services/itinerary-invoice-read.service.ts`, `test/itinerary-invoice-read.test.ts`
- Workflow: confirmed itinerary read projection after activity availability and before mutation workflows

#### Change

- Moved pluck-card reads, invoice reads, GST state labeling and invoice line-item/totals assembly behind `ItineraryInvoiceReadService`.
- Preserved plan/customer/settings predicates, parallel read ordering, financial arithmetic, missing-plan validation and response fields.
- Kept the three existing facade methods and controller/API contract unchanged.

#### Verification

- Invoice/pluck-card characterization tests: PASS, 2/2
- Combined focused backend/timeline suite: PASS, 147/147
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 10,654 lines after the tier; `ItineraryInvoiceReadService` is 383 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Confirmed-plan/customer/settings fan-out, line-item assembly CPU, payload size and end-to-end latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `8e7228b`.

### Cycle 71 - Extract manual-fit timeline policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: low-priority/manual-fit timeline validation and normalization policy
- New files: `src/modules/itineraries/services/itinerary-manual-fit-timeline-policy.service.ts`, `test/itinerary-manual-fit-timeline-policy.test.ts`
- Workflow: manual-fit preview and low-priority removal callback boundary

#### Change

- Moved resolved-timeline invariant validation, removed-row sanitization/pruning, retry classification, exact-anchor fit normalization and planned-removal detection behind `ItineraryManualFitTimelinePolicyService`.
- Preserved facade callback names, removed-row predicates, preview ordering metadata, diagnostic logging, retry semantics and exact-anchor response fields.
- Registered the new provider in `ItinerariesModule` so Nest runtime construction remains valid.

#### Verification

- Manual-fit timeline policy characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 150/150
- Backend build: PASS
- Nest/OpenAPI initialization: PASS, 499 paths
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 10,391 lines after the tier; `ItineraryManualFitTimelinePolicyService` is 313 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Timeline-policy CPU, removed-row volume, invariant-log volume and preview response latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `94d0f6c`.

### Cycle 72 - Extract matrix-preview timeline policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: matrix-preview timeline finalization, time repair, duration parsing and invariant diagnostics
- New files: `src/modules/itineraries/services/itinerary-matrix-preview-timeline-policy.service.ts`, `test/itinerary-matrix-preview-timeline-policy.test.ts`
- Workflow: matrix-assisted manual-fit preview and rescheduling callbacks

#### Change

- Moved travel-label normalization, placeholder time-range repair, preview duration parsing, clock-label formatting, duplicate suppression and matrix-order assertions behind `ItineraryMatrixPreviewTimelinePolicyService`.
- Preserved existing callback names, absolute/12-hour time formatting, row ordering, travel labels, duplicate fingerprints and debug assertion semantics.
- Registered the provider in `ItinerariesModule` and retained the facade adapters for all existing consumers.

#### Verification

- Matrix-preview timeline policy characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 153/153
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 9,988 lines after the tier; `ItineraryMatrixPreviewTimelinePolicyService` is 490 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Preview-policy CPU, placeholder-row frequency, duplicate suppression volume and response latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `c0dbb7b`.

### Cycle 73 - Extract manual-fit removal explanations

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual-fit removal evidence, explanations and changes-required presentation
- New files: `src/modules/itineraries/services/itinerary-manual-fit-removal-explanation.service.ts`, `test/itinerary-manual-fit-removal-explanation.test.ts`
- Workflow: manual-fit preview removal reporting and priority-confirmation response assembly

#### Change

- Moved duration/time display helpers, attempted-attraction enrichment, removal reason construction, priority summaries, authoritative removal selection and changes-required projection behind `ItineraryManualFitRemovalExplanationService`.
- Preserved reason precedence, operating-hours evidence, route-overflow evidence, priority ordering, attraction-only attempt source and response fields.
- Registered the service in `ItinerariesModule` and retained all facade callback names.

#### Verification

- Manual-fit removal explanation characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 156/156
- Backend build: PASS
- Nest/OpenAPI initialization: PASS, 499 paths
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 9,590 lines after the tier; `ItineraryManualFitRemovalExplanationService` is 518 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Explanation assembly CPU, removal-row volume, diagnostic payload size and preview latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `77b4a39`.

### Cycle 74 - Extract manual-fit route policy

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Extracted responsibility: manual insertion route-fit metadata, slot eligibility and city-context policy
- New files: `src/modules/itineraries/services/itinerary-manual-fit-route-policy.service.ts`, `test/itinerary-manual-fit-route-policy.test.ts`
- Workflow: manual-fit candidate selection and route-intelligence callbacks

#### Change

- Moved route-fit rank/labels, display metadata, valid matrix-slot checks, empty-route scheduler eligibility, matrix-build suggestions, location normalization and city-context classification behind `ItineraryManualFitRoutePolicyService`.
- Preserved route-fit precedence, relaxed manual timing rules, source/destination classification, normalized city keys and response metadata.
- Registered the service in `ItinerariesModule` and retained facade callback names.

#### Verification

- Manual-fit route policy characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 159/159
- Backend build: PASS
- Nest/OpenAPI initialization: PASS, 499 paths
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 9,285 lines after the tier; `ItineraryManualFitRoutePolicyService` is 363 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Route-fit policy CPU, candidate volume, city-classification frequency and response latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `befec89`.

### Cycle 75 - Consolidate manual-fit travel-replica helpers

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Consolidated responsibility: main-timeline travel-replica indexing and display fallback helpers
- Existing owner extended: `src/modules/itineraries/services/itinerary-manual-fit-travel-replica.service.ts`
- Workflow: manual-fit travel replica and exact-anchor rebuild callbacks

#### Change

- Moved check-in hotel-name extraction, travel-label normalization, distance parsing, duration fallback selection, main-timeline replica map construction and replica lookup into the existing travel-replica service.
- Preserved explicit-id, sequence-id, normalized-label and destination-key lookup precedence, duration fallback ordering and display labels.
- Kept the facade callback methods as compatibility adapters; no new provider wiring was required.

#### Verification

- Travel-replica characterization tests: PASS, 3/3
- Combined focused backend/timeline suite: PASS, 161/161
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 9,130 lines after the tier; `ItineraryManualFitTravelReplicaService` is 711 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Replica-map CPU, key-hit/miss distribution, duration-fallback frequency and response latency remain unmeasured.
- Implementation commit: `api.dvi.travel` `8e0a5b0`.

### Cycle 76 - Consolidate saved-rule travel-leg helpers

#### Scope

- Original file: `src/modules/itineraries/itineraries.service.ts`
- Consolidated responsibility: saved-rule travel-location classification, endpoint projection and travel-leg resolution
- Existing owner extended: `src/modules/itineraries/services/itinerary-manual-fit-travel-replica.service.ts`
- Workflow: matrix-preview rescheduling and manual-fit travel replica callbacks

#### Change

- Moved saved-rule location-type classification, HMS conversion, hotspot endpoint projection and source/hotspot/hotel leg resolution into the existing travel-replica service.
- Preserved route/hotel endpoint predicates, hotspot master projection, distance helper usage, buffer inclusion and travel-leg response fields.
- Kept facade callback methods as compatibility adapters and retained transaction-scoped reads.

#### Verification

- Saved-rule travel-replica characterization tests: PASS, 5/5
- Combined focused backend/timeline suite: PASS, 163/163
- Backend build: PASS
- `git diff --check`: PASS

#### Result

- `itineraries.service.ts` measured at 8,896 lines after the tier; `ItineraryManualFitTravelReplicaService` is 998 lines.
- No query shape, index, Redis, DTO, route or response contract changed.
- Saved-rule endpoint lookup latency, distance-helper latency, fallback frequency and transaction read volume remain unmeasured.
- Implementation commit: `api.dvi.travel` `0271b24`.
