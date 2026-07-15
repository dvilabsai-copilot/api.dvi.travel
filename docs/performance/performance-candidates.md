# Performance Candidates and Evidence Plan

Status: investigation only. This document records candidates found during the July 2026 refactoring and test pass. It does not approve schema changes, cache rollout, or behaviour changes.

## Executive decision

No index addition or removal is approved yet. The read-only database audit shows the shape of the schema, but it is not tied to a representative endpoint, query plan, rows examined, or write workload. Any proposed DDL must therefore remain a hypothesis until the evidence gates below are satisfied.

Redis is a plausible optimization for stable, read-heavy reference data and derived route calculations. It is not a safe blanket replacement for Prisma reads. Mutable itinerary state, pricing, availability, bookings, payments, wallets, and ledger data should remain database-authoritative unless a versioned invalidation design and consistency test are added first.

## Evidence currently available

| Area | Current evidence | Interpretation |
| --- | --- | --- |
| Database inventory | `docs/performance/database-audit-baseline.json` reports 182 tables and 2,288 index-column definitions. | Useful schema inventory only; it does not identify a missing or redundant index. |
| Performance Schema | Enabled during the audit and index-I/O counters were available. | Counters are not endpoint attribution and may have been reset or accumulated outside this workload. |
| Foreign keys | The audit returned no declared foreign-key relationships. | This may reflect the schema's modelling style or audit scope; it is not evidence that relationships are absent in application logic. |
| Timeline builder | Static inspection found repeated reads for plan/routes, hotspot places/timings, stored locations, global settings, via routes, persisted route rows, and hotel data. | These are candidates for batching, request memoization, projection, or caching. They are not confirmed N+1 defects until query logging measures them. |
| Itinerary details | Static inspection found plan, route, hotel, hotspot, activity, staff/agent, vendor, vehicle, permit, and location reads in one service. | The endpoint should be profiled as a query graph, including payload bytes and rows examined. |
| Verification | Focused backend suite: 35 passing tests; backend build: passing after the latest timeline extraction. | Refactoring safety signal only; no latency claim can be inferred. |

## Candidate index additions

These are query-shape hypotheses to validate, not migration instructions.

| Candidate access pattern | Likely tables/columns to inspect | Required proof before adding |
| --- | --- | --- |
| Load itinerary plan children by plan and stable ordering | `dvi_itinerary_route_details`, `dvi_itinerary_via_route_details`, `dvi_itinerary_route_hotspot_details`, `dvi_itinerary_route_activity_details`; parent/foreign-key-like plan or route columns plus order columns | Capture the exact generated SQL, run `EXPLAIN FORMAT=JSON`, confirm a selective predicate and measurable rows-examined reduction. Check existing composite-prefix coverage first. |
| Load hotspot timing/gallery/detail rows by hotspot/place | `dvi_hotspot_timing`, `dvi_hotspot_gallery_details`, `dvi_hotspot_place`; hotspot/place identifier and active/deleted/status predicates | Compare the current plan against a candidate composite index using a production-shaped identifier set. Include write frequency and index size. |
| Resolve stored locations by normalized lookup or coordinates | `dvi_stored_locations`; normalized name/city/type fields and coordinate fields used by the actual query | Prefer a stable identifier or materialized lookup key when possible. Do not index expressions or add a wide text index without measured selectivity and collation validation. |
| Read route-matrix/cache rows by origin, destination, and transport mode | `hotspot_route_matrix`, `hotspot_route_between_map`, `hotspot_route_between_rejections`; exact origin/destination/mode columns from the executed query | These tables are large enough that a covering or composite index may help, but only `EXPLAIN` plus workload sampling can establish column order. Validate duplicate coverage and insert/update cost. |
| Read hotel search/price records by request dimensions | `dvi_itinerary_hotel_search_cache`, `dvi_hotel_room_price_book`; exact supplier, destination, occupancy, date, currency, and status fields used by the query | Check whether application-level cache keys already provide the intended lookup. Measure expiry/delete workload before adding a large composite index. |

For every candidate, record: endpoint, responsibility, SQL fingerprint, bind-shape, call count, p50/p95 duration, rows returned, rows examined, sort/temp-table indicators, payload bytes, and write rate. A candidate is actionable only when it improves the representative read without unacceptable write amplification or plan regression.

## Candidate index removals

No removal is currently recommended.

The following observations are investigation signals only:

- A zero or low Performance Schema counter does not prove an index is unused; counters can reset and the audit is not a complete workload window.
- Similar index names do not prove duplicate coverage. Compare ordered column lists, uniqueness, prefix lengths, collation, and all known query predicates.
- A left-prefix duplicate may still be useful for ordering, uniqueness, or a different selectivity profile.
- Large indexes on high-write tables may be removal candidates, but removal requires a captured query window, application smoke coverage, and a reversible rollout plan.

Before proposing a removal, collect index usage over a representative period, compare `EXPLAIN` plans for all known consumers, check migration history and ORM assumptions, and stage the change as an invisible index or equivalent safe experiment where supported. The rollback must be exact DDL, not a comment or a guessed index definition.

## Redis candidates

### Good first candidates

1. **Route-distance and route-matrix lookups.** Cache deterministic results keyed by normalized origin, destination, transport mode, routing provider, and algorithm/version. Use a bounded TTL and include the algorithm version so a calculation change cannot reuse stale semantics.
2. **Stable hotspot reference data.** Cache hotspot place metadata and operating-hours rows when the invalidation path is known. Key by hotspot ID plus data version; invalidate on administrative edits.
3. **Read-only location resolution.** Cache normalized city/place lookups and coordinate resolution after measuring miss rate and cardinality. Bound the key length and normalize Unicode/case consistently with the application helper.
4. **Derived preview computations.** A short-lived, versioned cache may help repeated itinerary preview requests. Key by a canonical request hash, user/tenant scope, data version, and feature flags. Never allow one user's private itinerary data to cross scopes.

### Do not cache first

- Draft or confirmed itinerary mutations, booking confirmation, availability, pricing, payment, wallet, cancellation, or ledger responses.
- Data whose invalidation owner is unknown.
- Large nested responses when field-level changes are frequent; cache the stable reference inputs or a bounded projection instead.

### Required Redis design controls

- Namespaced keys with an explicit schema and algorithm version.
- TTL plus jitter to avoid synchronized expiry.
- Request coalescing or a short lock to prevent cache stampedes.
- Bounded value size and serialization cost; measure hit rate, miss latency, evictions, and error rate.
- Fail-open behaviour for non-authoritative reference caches, with a timeout and circuit breaker so Redis cannot become a new request bottleneck.
- Explicit invalidation events for writes, and a test proving stale data cannot cross tenant/user/plan scope.
- A rollout flag and a database-only fallback for quick rollback.

## Application and query optimizations

### High-value investigation areas

- Add request-scoped memoization for repeated reads of the same plan, route, stored location, hotspot, timing, or global setting. This is lower risk than a global cache and preserves transaction consistency.
- Batch by IDs before introducing parallelism. The timeline path already contains reads that should be compared for repeated identifiers and loop placement; measure query count first.
- Replace broad `include`/unbounded reads with explicit `select` projections after snapshotting the response contract. Track payload bytes, not only database duration.
- Bound gallery, activity, route, and history collections where the API contract permits pagination or a documented limit.
- Use `Promise.all` only for independent, read-only operations. Preserve transaction ordering and lock semantics for writes.
- Separate reference-data reads from mutable itinerary reads so a future cache can have a clear consistency boundary.
- Keep route/timeline policy helpers pure where possible; pure helpers are cheap to test and avoid database work during candidate evaluation.

### Measurement instrumentation

For a representative itinerary-details request, route rebuild, hotel search, and hotspot preview, capture:

1. Endpoint and responsibility name.
2. Prisma query event or SQL fingerprint, duration, call count, and transaction context.
3. Rows returned and, where available, rows examined and sort/temp-table indicators.
4. Serialized response size and major nested collection sizes.
5. Cache hit/miss, Redis duration, value size, and fallback count.
6. p50/p95/p99 latency over a repeatable fixture, including cold and warm runs.

The result should be committed as a timestamped, redacted artifact. Do not commit credentials, customer itinerary data, or unbounded raw payloads.

## Acceptance gates for a future optimization tier

An index, Redis cache, or query rewrite may move from candidate to implementation only when all applicable gates pass:

- The baseline and candidate use the same fixture, parameters, isolation level, and response contract.
- The query plan and measured latency improve for the target path without a material regression in related paths.
- Returned ordering, null handling, authorization scope, and transaction semantics are unchanged.
- Index size, write amplification, lock/DDL risk, cache memory, and invalidation cost are documented.
- The change has focused characterization tests, a rollback procedure, and a feature flag when introducing Redis.
- The tier is tested, documented, and committed independently of unrelated user edits.

## Next profiling order

1. Itinerary-details read graph and response projection.
2. Timeline builder repeated reads and candidate-evaluation loop boundaries.
3. Route-matrix and stored-location lookup fingerprints.
4. Hotel search/price cache access patterns.
5. Only then, index experiments or Redis implementation for the measured winner.

Related evidence: [`database-optimization-progress.md`](./database-optimization-progress.md), [`index-analysis.md`](./index-analysis.md), [`index-proposals.sql`](./index-proposals.sql), and [`database-audit-baseline.json`](./database-audit-baseline.json).
