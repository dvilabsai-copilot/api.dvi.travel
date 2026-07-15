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

## Refactoring performance log

| Tier | Boundary | Structural result | Performance result |
| --- | --- | --- | --- |
| Timeline iterations 1–5 | Slot, rejection, route, anchor and data-access policies | `timeline.builder.ts` reduced from 10,302 to 9,612 lines; focused tests remained green | No query/index/cache change; endpoint measurements not available |
| Timeline iteration 6 | Travel/location data boundary | `timeline.builder.ts` reduced from 9,612 to 9,374 lines; `TimelineTravelDataService` owns 290 lines | Existing Prisma filters and distance calls preserved; query count, rows examined, payload and latency remain unmeasured |
| Timeline iteration 7 | Candidate feasibility boundary | `timeline.builder.ts` reduced from 9,374 to 9,182 lines; `TimelineCandidateFeasibilityService` owns 314 lines | Scheduling checks are isolated without query/index/cache changes; endpoint timings and query counts remain unmeasured |
| Itinerary iteration 8 | Guide assignment and pricebook boundary | `itineraries.service.ts` reduced from 37,224 to 36,843 lines; `ItineraryGuideAssignmentService` owns 337 lines | Existing guide reads and pricebook filters preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 9 | Vehicle-build status repository/state boundary | `itineraries.service.ts` reduced from 36,843 to 36,603 lines; `ItineraryVehicleBuildStatusService` owns 316 lines | Existing status-table SQL, readiness counts and DB/memory fallback preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 10 | Vehicle-build orchestration boundary | `itineraries.service.ts` reduced from 36,603 to 36,115 lines; `ItineraryVehicleBuildService` owns 473 lines | Existing build stages, retry/timeout policy and vendor-selection ordering preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 11 | Plan-save and reusable-template persistence boundary | `itineraries.service.ts` reduced from 36,115 to 35,433 lines; `ItineraryPlanPersistenceService` owns 821 lines | Existing transaction ordering and template reads/writes preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 12 | Activity add/preview/delete workflow boundary | `itineraries.service.ts` reduced from 35,433 to 34,784 lines; `ItineraryActivityWorkflowService` owns 750 lines | Existing activity reads, timing policy callbacks and transaction ordering preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 13 | Smart activity transaction/rebuild boundary | `itineraries.service.ts` reduced from 34,784 to 33,522 lines; `ItinerarySmartActivityService` owns 1,352 lines | Existing smart-preview rollback, movement/rebuild and insertion semantics preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 14 | Hotspot availability/add/preview workflow boundary | `itineraries.service.ts` reduced from 33,522 to 32,712 lines; `ItineraryHotspotWorkflowService` owns 891 lines | Existing location filtering, ordering/interleaving and manual-preview delegation preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 15 | Hotel and vehicle selection/rebuild workflow boundary | `itineraries.service.ts` reduced from 32,712 to 32,159 lines; `ItinerarySelectionWorkflowService` owns 604 lines | Existing Haversine hotel search, selection preservation, rate validation, slab rebuild and active-vendor filtering preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 16 | Quote edit/customer/wallet read boundary | `itineraries.service.ts` reduced from 32,159 to 31,955 lines; `ItineraryQuoteContextService` owns 232 lines | Existing edit projections, agent/city formatting and wallet fallback arithmetic preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 17 | Quotation confirmation transaction boundary | `itineraries.service.ts` reduced from 31,955 to 31,061 lines; `ItineraryConfirmationService` owns 980 lines | Existing wallet deduction, confirmation persistence, hotel normalization and transaction ordering preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 18 | Hotel confirmation support boundary | `itineraries.service.ts` reduced from 31,061 to 30,356 lines; `ItineraryHotelConfirmationSupportService` owns 786 lines | Existing selected-hotel draft writes, financial finalization and provider-success filtering preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 19 | Hotel prebook and booking-code boundary | `itineraries.service.ts` reduced from 30,356 to 29,920 lines; `ItineraryHotelPrebookService` owns 500 lines | Existing TBO prebook payload handling, room normalization, supplement normalization and fresh booking-code resolution preserved; query count, rows examined, payload and latency remain unmeasured |
| Itinerary iteration 20 | Hotel booking fulfillment boundary | `itineraries.service.ts` reduced from 29,920 to 29,565 lines; `ItineraryHotelBookingFulfillmentService` owns 441 lines | Existing provider dispatch, duplicate-success filtering, result aggregation and finalization callbacks preserved; provider latency, retry volume and query count remain unmeasured |

The iteration-6 and iteration-7 boundaries are measurement seams, not optimization claims. The next safe performance tier should instrument representative itinerary-details, route-rebuild and hotspot-preview requests and attribute calls to `TimelineTravelDataService` and `TimelineCandidateFeasibilityService` before changing query shape or adding a cache.

The iteration-8 guide boundary is also a measurement seam. Guide availability currently resolves candidates and pricebook rows per requested date; any batching or request memoization must first capture call counts and preserve date-wise ordering and GST semantics.

The iteration-9 vehicle-build status boundary is a measurement seam for status polling and build completion. The status contract intentionally still performs the existing count/read work; any memoization or index proposal must distinguish polling frequency from build execution and verify readiness semantics against fresh rows.

The iteration-10 vehicle-build boundary is a measurement seam for stage duration, transaction wait time, eligible-row volume, vehicle-detail volume and status polling. Do not parallelize stages or cache mutable pricing/availability data without a representative build trace and a proof that transaction ordering and selection semantics remain unchanged.

The iteration-11 plan-persistence boundary is a measurement seam for transaction wait time, route/hotspot child-row volume, post-transaction rebuild duration, template snapshot payload size and template lookup selectivity. Profile representative create, update and template-match requests separately before considering batching, projections or index changes.

The iteration-12 activity boundary is a measurement seam for activity lookup/time-slot calls, per-hotspot duplicate checks, pricing reads, cascade row volume and rebuild duration. Profile add, preview and delete separately; do not batch or cache mutable activity pricing/availability until consistency and invalidation ownership are proven.

The iteration-13 smart-activity boundary is a measurement seam for preview transaction duration, hotspot-row churn, rollback work, priority-removal loops and insertion rebuild cost. Treat preview and apply/insert as separate workloads; do not optimize by parallelizing or caching mutable timeline state before capturing transaction and row-volume evidence.

The iteration-14 hotspot boundary is a measurement seam for route/location reads, hotspot candidate volume, source/destination classification, manual preview calls and add/preview persistence. Profile availability, anchor availability, add and preview separately before considering batching or caching reference data.

The iteration-15 selection boundary is a measurement seam for hotel route/location reads, Haversine candidate scans, hotel-selection writes, vendor eligibility reads, vehicle-detail rebuilds and selection re-application. Profile hotel search, single/bulk hotel selection, vendor selection, slab selection and auto-selection separately; only then evaluate spatial indexing, composite indexes, batching or cache invalidation for mutable pricing and assignment data.

The iteration-16 quote-context boundary is a measurement seam for edit-page route/via fan-out, traveller and vehicle payload size, agent configuration lookup and wallet fallback scans. Profile edit reads and customer/wallet reads separately; consider projections, batching or indexes only after measuring route count, child-row volume and wallet transaction selectivity.

The iteration-17 confirmation boundary is a measurement seam for pre-confirmation reads, wallet fallback scans, hotel draft cleanup row volume, transaction wait/lock time, confirmation child-row inserts and post-transaction copy work. Profile confirmation with no supplier bookings separately from provider-booking confirmation; do not parallelize writes, cache wallet state, or change transaction scope without evidence from both workloads.

The iteration-18 support boundary is a measurement seam for selected-hotel draft row churn, multi-night expansion volume, route lookup fan-out, financial finalization transaction wait and provider-confirmation lookup scans. Profile draft synchronization, financial finalization and already-successful filtering independently; only then consider batching or composite indexes, and keep external provider calls out of database transactions.

The iteration-19 prebook boundary is a measurement seam for room-detail cache misses, supplier prebook latency, response payload size, supplement normalization volume and fresh booking-code fallback searches. Measure TBO prebook and room-refresh paths separately; do not cache mutable booking codes or parallelize supplier calls without provider consistency and timeout evidence.

The iteration-20 fulfillment boundary is a measurement seam for per-provider latency, retry/error volume, duplicate-success lookup rows, callback finalization time and aggregate response payload size. Measure TBO, ResAvenue, HOBSE, AxisRooms and STAAH separately; do not parallelize provider calls or change retry/finalization ordering without provider-specific evidence.

## Next profiling order

1. Itinerary-details read graph and response projection.
2. Timeline builder repeated reads and candidate-evaluation loop boundaries.
3. Route-matrix and stored-location lookup fingerprints.
4. Hotel search/price cache access patterns.
5. Only then, index experiments or Redis implementation for the measured winner.

Related evidence: [`database-optimization-progress.md`](./database-optimization-progress.md), [`index-analysis.md`](./index-analysis.md), [`index-proposals.sql`](./index-proposals.sql), and [`database-audit-baseline.json`](./database-audit-baseline.json).
