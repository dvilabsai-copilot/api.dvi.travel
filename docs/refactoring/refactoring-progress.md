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
