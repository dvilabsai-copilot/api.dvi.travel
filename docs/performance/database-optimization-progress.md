# Database Optimization Progress

## Baseline

- No production SQL was executed.
- No index was added or removed.
- No query was changed.
- Query count, rows examined, payload size and database duration are not yet measured.

## Read-only schema audit

`npm run audit:database` runs read-only `information_schema` and, when enabled, `performance_schema` queries against `DATABASE_URL`. It writes `database-audit-baseline.json` with table-size estimates, index definitions, foreign-key relationships, audit-query durations and available index-I/O counters. It never runs DDL or DML.

The generated artifact is evidence about the selected database only. It does not represent endpoint query counts, production latency or index usefulness without a captured request and query plan.

## Evidence required before optimization

1. Capture a representative fixture request with query logging enabled in a safe environment.
2. Attribute each query to one extracted responsibility.
3. Compare query plans and result ordering before/after.
4. Separate index proposals from code changes and provide exact rollback SQL.

## Current hypotheses (not recommendations)

The oversized itinerary/details/timeline paths are candidates for repeated reads, nested includes and queries inside loops. These are hypotheses from static inspection only and must not be reported as confirmed N+1 defects until measured.

The broader candidate register, including index-addition/removal evidence gates, Redis suitability and invalidation controls, and query-level profiling fields, is maintained in [`performance-candidates.md`](./performance-candidates.md).

## Iteration 51 evidence update

- The route-hotspot planning extraction changed code ownership only; no SQL, index, Redis cache or query shape was changed.
- The builder-local static Prisma-call count decreased from 12 to 11 because the existing active via-route read now belongs to `TimelineRouteHotspotPlanningService`.
- This is not a measured performance improvement: query duration, rows examined, fallback volume, cacheability and rebuild latency remain unmeasured.
- Required next evidence is a representative route-build trace split by local, direct inter-city, via-route, Day-1 fallback and same-city continuation workloads, with query plans captured before any index or cache proposal.

## Iteration 52 evidence update

- The manual/same-city placement extraction is pure in-memory policy code; no SQL, index, Redis cache or query shape was changed.
- Static Prisma-call ownership remains 11 matches in `timeline.builder.ts`; this tier has no database call to optimize or relocate.
- This is not a measured performance improvement: selection volume, sort CPU, response payload and rebuild latency remain unmeasured.
- Any future memoization or Redis proposal must first prove stable placement-input versions and route/preview scope isolation; no cache rollout is approved by this tier.

## Iteration 53 evidence update

- The destination-loopback reservation extraction preserved the existing candidate read callback and transaction ownership; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 11 matches because the extracted policy delegates candidate reads rather than changing their SQL.
- This is not a measured performance improvement: next-route candidate latency, rows examined, fallback/rescue volume and rebuild latency remain unmeasured.
- Required evidence before any index or Redis proposal is a route-build trace with eligible/ineligible reservation branches, candidate counts and query plans captured against the same fixture.

## Iteration 54 evidence update

- The carry-forward attachment extraction is pure in-memory policy code; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 11 matches; this tier delegates the existing merge policy and performs no database work.
- This is not a measured performance improvement: queue size, merge CPU, fallback frequency and rebuild latency remain unmeasured.
- No index or Redis action is proposed; any future memoization must prove continuation-chain versioning and route/plan scope isolation first.

## Iteration 55 evidence update

- The matrix-autobuild extraction moved the existing active route-hotspot read behind a service but did not change SQL, predicates, ordering, indexes or Redis behavior.
- Builder-local static Prisma-call ownership decreased from 11 to 10; the extracted service contains the retained route-hotspot `findMany` call.
- This is not a measured performance improvement: route-attraction rows, between-map duration, rows examined, candidate rejection volume and rebuild latency remain unmeasured.
- Any index or Redis proposal must first compare flag-off/flag-on traces and query plans for representative slot-pair counts, with the feature flag remaining the rollback control.

## Iteration 56 evidence update

- Candidate reordering is pure in-memory policy code; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 10 matches; this tier performs no database work.
- This is not a measured performance improvement: candidate count, sort CPU, payload ordering cost and rebuild latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must preserve deterministic ordering and be supported by representative route-build measurements.

## Iteration 57 evidence update

- The Day-1 candidate gate is pure in-memory policy code; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 10 matches; the gate performs no database work.
- This is not a measured performance improvement: rejection distribution, logging cost, duplicate frequency and rebuild latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must preserve gate order, movement exceptions and strict priority semantics.

## Iteration 58 evidence update

- The Day-1 cutoff/master admission extraction uses the existing in-memory hotspot map; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 10 matches; this tier performs no database work.
- This is not a measured performance improvement: cutoff frequency, map misses, logging cost and rebuild latency remain unmeasured.
- No index or Redis action is proposed; any future cache must preserve route-scope, loopback bypass and absolute-time semantics.

## Iteration 59 evidence update

- The Day-1 travel-projection extraction keeps the existing coordinate fallback and travel/projected-arrival callbacks; no SQL, index, Redis cache or query shape was changed.
- Builder-local static Prisma-call ownership remains 10 matches; the extracted service performs no direct database work.
- This is not a measured performance improvement: coordinate fallback frequency, provider latency, projected-arrival rejection volume, evaluation-log cost and rebuild latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must be supported by route-build traces and query plans while preserving absolute-time projection, wrapped persistence values and rejection order.

## Iteration 60 evidence update

- The draft guide-assignment write extraction preserves the existing plan, route, guide and pricebook reads plus guide-row/slot-row transaction; no SQL, index, Redis cache or query shape was changed.
- Static database-call ownership remains 613 matches in the facade inventory; the new service owns the existing write-path calls without changing predicates or projections.
- This is not a measured performance improvement: guide-candidate selectivity, pricebook latency, route-date fan-out, slot-row volume and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route-specific and whole-itinerary query plans and preserve cost resolution, transaction ordering and response semantics.

## Iteration 61 evidence update

- The draft guide-assignment deletion extraction preserves the existing two-step transaction (slot-cost cleanup, then guide-row deletion); no SQL, index, Redis cache or query shape was changed.
- The facade retains the same database-call inventory; this tier changes ownership only and does not alter predicates or transaction boundaries.
- This is not a measured performance improvement: delete frequency, route selectivity, cleanup volume and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must preserve cleanup ordering and route/plan scoping.

## Iteration 62 evidence update

- The confirmed-guide projection extraction preserves the existing confirmed plan, guide, slot, route, guide-master and language reads plus lazy slot-cost backfill; no SQL, index, Redis cache or query shape was changed.
- The facade delegates the same query sequence and response projection; no predicates, ordering or transaction client semantics changed.
- This is not a measured performance improvement: read fan-out, master selectivity, grouping CPU, backfill frequency, payload size and response latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare empty/single/multi-slot and backfill query plans while preserving cancellation-visible slot state.

## Iteration 63 evidence update

- The confirmed guide-slot cancellation extraction preserves the existing confirmed-plan/guide/slot reads, cancellation writes, aggregates and audit callback; no SQL, index, Redis cache or query shape was changed.
- The cancellation transaction still owns the same route and itinerary aggregate predicates, status transitions and financial writes; only orchestration ownership moved.
- This is not a measured performance improvement: lookup latency, backfill frequency, write volume, aggregate fan-out, audit latency and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare first/partial/full cancellation query plans and preserve rounding, status order and audit semantics.

## Iteration 64 evidence update

- The manual-fit attempt-store extraction preserves the existing table DDL, raw upsert/select/delete statements and in-memory cache; no index, Redis cache or query shape was changed.
- The facade remains a compatibility adapter for the manual-fit helper, while the service owns the same SQL and cache ordering.
- This is not a measured performance improvement: table setup, raw query latency, cache-hit rate, serialization cost, payload size and delete latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare first-use/cache-hit/DB-fallback traces and preserve expiry and SQL semantics.

## Iteration 65 evidence update

- The route-hotspot deletion extraction preserves the existing identity lookups, dependent activity/timeline deletes, exclusion update and rebuild calls; no SQL, index, Redis cache or query shape was changed.
- Transaction timeout, deletion predicates, rebuild order and vehicle-pricing callback semantics remain unchanged; only orchestration ownership moved.
- This is not a measured performance improvement: lookup latency, dependent-row volume, rebuild duration, parking refresh duration and vehicle refresh latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route-hotspot-ID/master-ID fallback plans and preserve cleanup/rebuild ordering.

## Iteration 66 evidence update

- The activity-availability extraction preserves the existing activity, time-slot and pricing reads; no SQL, index, Redis cache or query shape was changed.
- Activity ordering, slot ordering, pricing callback arguments and response projection remain unchanged; only orchestration ownership moved.
- This is not a measured performance improvement: activity/slot fan-out, pricing latency, selectivity, empty-catalog rate and payload size remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare empty/single/multi-activity query plans and preserve response ordering.

## Iteration 67 evidence update

- The confirmed invoice/pluck-card extraction preserves the existing confirmed-plan, customer, settings, agent, account and component reads; no SQL, index, Redis cache or query shape was changed.
- Parallel read ordering, GST state labeling, line-item ordering, financial totals and missing-plan validation remain unchanged; only presentation-read orchestration ownership moved.
- This is not a measured performance improvement: lookup latency, child-row volume, assembly CPU, payload size, cacheability and end-to-end response latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare pluck-card/invoice query plans and preserve financial and response contracts.
