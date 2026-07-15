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

#### Verification

- Read-only database audit: PASS; 182 tables, 2,288 index definitions, Performance Schema enabled
- No DDL/DML executed

#### Result

- Index rollback SQL and approval gates are present without speculative production changes.

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
