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
| Itinerary iteration 21 | Confirmed-plan copy boundary | `itineraries.service.ts` reduced from 29,565 to 29,089 lines; `ItineraryConfirmedPlanCopyService` owns 504 lines | Existing transaction-scoped child-row copy ordering preserved; copied row counts, transaction wait and payload volume remain unmeasured |
| Itinerary iteration 22 | Cancellation transaction boundary | `itineraries.service.ts` reduced from 29,089 to 28,519 lines; `ItineraryCancellationService` owns 602 lines | Existing cancellation validation, child cleanup, provider cancellation, audit and notification ordering preserved; query count, rows examined, provider latency and transaction wait remain unmeasured |
| Itinerary iteration 23 | Itinerary listing/filter read boundary | `itineraries.service.ts` reduced from 28,519 to 27,963 lines; `ItineraryListingService` owns 615 lines | Existing role scoping, date filters, global search, pagination and projections preserved; query count, rows examined, payload size and latency remain unmeasured |
| Itinerary iteration 24 | Hotel and transport voucher read boundary | `itineraries.service.ts` reduced from 27,963 to 27,228 lines; `ItineraryVoucherReadService` owns 810 lines | Existing voucher child reads, labels, date/location formatting and passenger projections preserved; query count, rows examined, payload size and latency remain unmeasured |
| Itinerary iteration 25 | Manual hotspot matrix-build boundary | `itineraries.service.ts` reduced from 27,228 to 27,086 lines; `ItineraryManualHotspotMatrixService` owns 190 lines | Existing matrix lock, route/city gating, OSRM options and result codes preserved; external routing latency, matrix row volume and failure rate remain unmeasured |
| Itinerary iteration 26 | Manual hotspot preview/Fit Here boundary | `itineraries.service.ts` reduced from 27,086 to 26,618 lines; `ItineraryManualHotspotPreviewService` owns 591 lines | Existing preview transaction rollback, cache/fingerprint behavior and Fit Here entry points preserved; transaction duration, cache hit rate and payload size remain unmeasured |
| Itinerary iteration 27 | Manual hotspot add/batch mutation boundary | `itineraries.service.ts` reduced from 26,618 to 26,296 lines; `ItineraryManualHotspotMutationService` owns 402 lines | Existing add projection, batch transaction, cleanup, timing and pricing-rebuild callbacks preserved; transaction duration, row churn and retry count remain unmeasured |
| Itinerary iteration 28 | Manual fit matrix planning boundary | `itineraries.service.ts` reduced from 26,296 to 25,649 lines; `ItineraryManualFitMatrixPlanningService` owns 778 lines | Existing detour anchor inference, matrix gap selection and low-priority-removal timeline ordering preserved; query count, rows examined, route-leg volume, CPU and latency remain unmeasured |
| Itinerary iteration 29 | Exact-anchor sequential rebuild boundary | `itineraries.service.ts` reduced from 25,649 to 24,815 lines; `ItineraryExactAnchorRebuildService` owns 978 lines | Existing transaction reads, directional ordering, operating-window adjustments, travel replicas and bounded cache behavior preserved; query count, rows examined, rebuild CPU and latency remain unmeasured |
| Itinerary iteration 30 | Low-priority removal planning boundary | `itineraries.service.ts` reduced from 24,815 to 24,121 lines; `ItineraryLowPriorityRemovalService` owns 819 lines | Existing candidate priority ordering, combination-search cap, greedy fallback, route evidence and snapshot validation preserved; query count, candidate volume, simulation count and latency remain unmeasured |
| Itinerary iteration 31 | Matrix-safe manual insertion boundary | `itineraries.service.ts` reduced from 24,121 to 22,867 lines; `ItineraryMatrixSafeInsertionService` owns 1,315 lines | Existing active-row checks, matrix slot validation, transaction writes, timing persistence, removal application and strict validation preserved; query count, row churn, transaction wait and latency remain unmeasured |
| Itinerary iteration 32 | Preview timeline application boundary | `itineraries.service.ts` reduced from 22,867 to 22,270 lines; `ItineraryPreviewTimelineApplicationService` owns 655 lines | Existing insertion projection, destination pruning, pivot cleanup, timing labels and ordering preserved; row count, CPU, cache effects and latency remain unmeasured |
| Itinerary iteration 33 | Route-leg runtime cache and provider fallback boundary | `itineraries.service.ts` reduced from 22,270 to 22,058 lines; `ItineraryRouteLegCacheService` owns 263 lines | Existing OSRM key/TTL policy, reverse-leg lookup, stored-coordinate reads and distance/duration fallbacks preserved; cache hit/miss, expiry, provider latency, route-leg count, payload size and memory remain unmeasured |
| Itinerary iteration 34 | Manual-hotspot batch transaction boundary | `itineraries.service.ts` reduced from 22,058 to 19,183 lines; `ItineraryManualHotspotBatchService` owns 2,967 lines | Existing matrix-fit decisions, adaptive scheduling, preview reconstruction, priority-removal rescue, rollback and response assembly preserved; transaction duration, row churn, callback CPU, route-leg volume, payload size and latency remain unmeasured |
| Itinerary iteration 35 | Manual insertion-fit query and slot-selection boundary | `itineraries.service.ts` reduced from 19,183 to 16,987 lines; `ItineraryManualInsertionFitService` owns 2,254 lines | Existing city-endpoint, single-hotspot, route-between-map, destination-hotel and timing-aware slot ranking preserved; raw-query latency, rows examined, matrix row volume, callback CPU, payload size and end-to-end latency remain unmeasured |
| Itinerary iteration 36 | Progressive priority-removal planning boundary | `itineraries.service.ts` reduced from 16,987 to 15,605 lines; `ItineraryProgressivePriorityRemovalService` owns 1,437 lines | Existing same-route candidate audit, priority protection, exact-anchor rescue, timing evaluation and simulation ordering preserved; candidate volume, simulation CPU, rebuild rows, transaction duration, rollback rate and latency remain unmeasured |
| Itinerary iteration 37 | Adaptive manual-hotspot set insertion boundary | `itineraries.service.ts` reduced from 15,605 to 14,833 lines; `ItineraryAdaptiveManualHotspotInsertionService` owns 815 lines | Existing baseline optimizer sequencing, optional/P3/protected-priority removal, preview simulation, confirmation metadata and response envelopes preserved; candidate volume, optimizer CPU, rebuild rows, transaction duration, rollback rate and latency remain unmeasured |
| Itinerary iteration 38 | Matrix-rescheduled preview assembly boundary | `itineraries.service.ts` reduced from 14,833 to 14,076 lines; `ItineraryMatrixRescheduledPreviewService` owns 797 lines | Existing source/anchor/hotel leg reconstruction, matrix timing rescheduling, duplicate-travel cleanup, ordering assertions and final arrival metadata preserved; callback CPU, route-leg cache hit rate, rebuilt rows, transaction duration, response size and latency remain unmeasured |
| Itinerary iteration 39 | Confirmed-itinerary booked-hotel projection boundary | `itineraries.service.ts` reduced from 14,076 to 13,554 lines; `ItineraryConfirmedItineraryDetailsService` owns 547 lines | Existing confirmed-plan/original-plan reads, provider booking normalization, hotel/master enrichment, room/meal labels, cancellation flags and availability metadata preserved; query count, rows examined, provider payload size, callback CPU and latency remain unmeasured |
| Itinerary iteration 40 | Matrix baseline-merge consolidation boundary | `itineraries.service.ts` reduced from 14,076 to 13,251 lines; `ItineraryMatrixRescheduledPreviewService` now owns 1,100 lines | Existing baseline/engine merge fallback, selected-row preparation, slot validation and finalization callbacks preserved; merge CPU, row churn, duration-policy calls, response size and end-to-end latency remain unmeasured |
| Itinerary iteration 41 | Route timing and rebuild boundary | `itineraries.service.ts` reduced from 13,251 to 12,931 lines; `ItineraryRouteTimingService` owns 367 lines | Existing route-time validation, itinerary-boundary recalculation, billing markers, timeline rebuild and parking/vehicle pricing refresh preserved; transaction duration, lock wait, rebuild rows, pricing callback CPU and latency remain unmeasured |
| Itinerary iteration 42 | Manual-fit travel replica display boundary | `itineraries.service.ts` reduced from 12,931 to 12,459 lines; `ItineraryManualFitTravelReplicaService` owns 518 lines | Existing duration/distance normalization, hotel check-in travel insertion, saved-leg fallback, source-to-hotspot resolution and map-table support preserved; OSRM calls, fallback frequency, row churn, callback CPU, payload size and latency remain unmeasured |
| Itinerary iteration 43 | Manual-fit geometry and endpoint boundary | `itineraries.service.ts` reduced from 12,459 to 12,074 lines; `ItineraryManualFitGeometryService` owns 439 lines | Existing coordinate parsing, route projection, OSRM geometry, selected/destination hotel endpoint resolution and hotspot-to-hotel fallback preserved; OSRM latency, endpoint query count, fallback frequency, projection CPU, row churn and latency remain unmeasured |
| Timeline iteration 44 | Candidate/timing/route policy boundary | `timeline.builder.ts` reduced from 9,182 to 8,826 lines; `TimelineCandidatePolicyService` owns 468 lines | Existing timing adapters, slot decisions, carry-forward ordering/merge, route-chain policy, rejection classification and evaluation reporting preserved; candidate volume, policy CPU, trace writes, route rebuild rows and latency remain unmeasured |
| Timeline iteration 45 | Input-loading/data-access boundary | `timeline.builder.ts` reduced from 8,826 to 8,794 lines; `TimelineDataAccessService` is 233 lines | Existing plan/route/active-hotspot/active-timing reads, route ordering and timing-map grouping preserved; query latency, rows examined, timing-map memory, prefilter volume and rebuild latency remain unmeasured |

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

The iteration-21 confirmed-plan copy boundary is a measurement seam for child-row volume by table, transaction wait/lock time and draft-to-confirmed payload size. Profile copy work by itinerary size before considering bulk inserts or parallel writes; preserve parent/child ordering and transaction atomicity.

The iteration-22 cancellation boundary is a measurement seam for cancellation transaction wait/lock time, child-table row volume, provider cancellation latency and notification dispatch time. Profile already-cancelled, no-provider and provider-cancellation paths separately; do not parallelize cleanup or external cancellation calls without preserving transaction and retry semantics.

The iteration-23 listing boundary is a measurement seam for filter selectivity, global-search raw SQL cost, count/data query duplication, pagination depth and response payload size. Profile confirmed, cancelled and accounts listings separately before considering composite indexes, keyset pagination or projection changes.

The iteration-24 voucher boundary is a measurement seam for hotel/vehicle child-row fan-out, route-hotspot reads, vehicle/gallery lookups, raw transport-cost queries and response payload size. Profile hotel and transport voucher generation separately before considering projections, batching or indexes.

The iteration-25 matrix boundary is a measurement seam for OSRM latency, route-pair count, matrix row volume, timeout/failure rate and lock contention. Measure source/destination-side and repeated-build scenarios separately; do not add Redis caching or increase concurrency without validating freshness and provider limits.

The iteration-26 preview boundary is a measurement seam for preview transaction duration, rollback cost, snapshot row volume, retry count, cache hit/miss rate and Fit Here payload size. Profile single, batch, exact-anchor and Fit Here workloads separately before considering Redis or transaction parallelism.

The iteration-27 mutation boundary is a measurement seam for batch transaction duration, hotspot-row churn, cleanup volume, vehicle-pricing rebuild cost and retry count. Profile single-add and multi-hotspot batch paths separately; do not parallelize writes or cache mutable timeline/pricing state without consistency evidence.

The iteration-28 manual-fit matrix boundary is a measurement seam for active-attraction lookup selectivity, hotspot coordinate rows, route-matrix leg calls, timeline row volume and reconstruction CPU/latency. Profile anchor inference, insertion-gap resolution and low-priority removal separately; only then evaluate composite indexes or Redis for immutable coordinate/matrix data, with freshness and invalidation documented before implementation.

The iteration-29 exact-anchor boundary is a measurement seam for transaction read fan-out, persisted-attraction row volume, direction-master lookup selectivity, route-leg calls, operating-window enrichment, cache hit rate and rebuilt timeline payload size. Profile exact-anchor rebuilds by removal count and route size before changing cache capacity, adding indexes or parallelizing route reads; preserve transaction snapshots and ordering semantics.

The iteration-30 low-priority removal boundary is a measurement seam for route-attraction/master lookup selectivity, candidate count, combination-search attempts, reconstructed timeline rows, transaction duration and response payload size. Profile preselected, combination-search and greedy-fallback workloads separately; do not raise the combination cap, parallelize simulations or cache mutable route evidence before measuring CPU, query fan-out and consistency cost.

The iteration-31 matrix-safe insertion boundary is a measurement seam for active-row lookup selectivity, route-hotspot write count, excluded-list churn, timeline rebuild rows, transaction wait/lock time and response size. Profile already-present, normal matrix, exact-anchor and removal-assisted paths separately; do not parallelize writes or cache mutable route state before measuring transaction and invalidation costs.

The iteration-32 preview application boundary is a measurement seam for baseline timeline row volume, repeated duration/operating-window policy calls, destination-side pruning cost, preview payload size and end-to-end CPU/latency. Profile normal, exact-anchor and destination-side previews separately before caching or reordering transformations; preserve the existing final-row ordering contract.

The iteration-33 route-leg boundary is a measurement seam for runtime-cache hit/miss/expiry rates, reverse-leg reuse, OSRM latency and failure rate, stored-coordinate query count, route-leg volume, geometry payload size and process memory. Profile normal rebuild, repeated preview and multi-route workloads separately before moving this cache to Redis or changing its TTL; preserve provider-fallback ordering and document key cardinality, freshness, invalidation and cross-instance consistency first.

The iteration-34 manual-hotspot batch boundary is a measurement seam for transaction duration and wait time, active-row and route-hotspot row churn, matrix/OSRM callback count, adaptive candidate/simulation volume, preview reconstruction CPU, rollback frequency, response payload size and end-to-end latency. Profile single-add, batch-add, preview-only, exact-anchor, destination-side and removal-rescue workloads separately before splitting or caching this workflow; preserve transaction atomicity, callback ordering, provider limits and response envelopes.

The iteration-35 insertion-fit boundary is a measurement seam for route/location/hotspot lookup selectivity, raw `hotspot_route_between_map` rows examined, city-endpoint and destination-hotel matrix volume, route-fit ranking CPU, OSRM leg calls, fallback frequency and response payload size. Profile empty-route, single-hotspot, multi-hotspot, destination-side and timing-relaxed workloads separately before adding indexes, batching raw queries or caching matrix data; preserve matrix freshness, route-fit ordering and mutable endpoint invalidation.

The iteration-36 progressive-removal boundary is a measurement seam for active-route row selectivity, candidate count by priority, same-route filtering, simulation-attempt count, timeline rebuild rows, operating-hours enrichment, snapshot payload size, transaction duration and response latency. Profile day-end, selected-closing, exact-anchor and fallback-candidate workloads separately before changing combination limits, parallelizing simulations or caching mutable timeline state; preserve priority protection and deterministic attempt ordering.

The iteration-37 adaptive-insertion boundary is a measurement seam for candidate rebuild count, optional/P3/protected-priority candidate volume, optimizer attempt count, preview simulation CPU, route-hotspot row churn, excluded-list writes, transaction duration, confirmation frequency and response latency. Profile successful baseline, optional-removal, P3-removal, protected-priority and preview-only workloads separately before changing optimizer limits, parallelizing attempts, adding indexes or moving mutable candidate state to Redis; preserve deterministic priority ordering, transaction ownership and confirmation semantics.

The iteration-38 matrix-preview boundary is a measurement seam for merged baseline row count, source/anchor/hotel saved-rule lookup count, runtime route-leg cache hit/miss/expiry, rescheduling CPU, duplicate-travel cleanup count, invariant warnings, final timeline row count, response size and end-to-end latency. Profile empty, source-side, destination-side, hotel-anchored and exact-anchor previews separately before changing route-leg caching, query shape or rescheduling order; preserve matrix split-leg ordering and timing metadata.

The iteration-39 confirmed-details boundary is a measurement seam for confirmed-plan/original-plan lookup count, route and hotel child-row volume, provider confirmation row volume by provider, room-type and master enrichment selectivity, guide-assignment reads, response payload size and end-to-end latency. Profile empty-booking, single-provider, mixed-provider and cancelled-voucher workloads separately before batching queries, changing projections, adding indexes or caching provider data; preserve provider precedence, cancellation semantics and response envelopes.

The iteration-40 matrix-merge boundary is a measurement seam for baseline versus engine row counts, selected-row lookup volume, merge/replacement CPU, timing-policy callback count, finalization/deduplication work, response row count and payload size. Profile no-fit fallback, source-side, destination-side and selected-row replacement workloads separately before changing merge order or caching preview state; preserve selected-anchor ordering and matrix split-leg semantics.

The iteration-41 route-timing boundary is a measurement seam for route-row selectivity, plan-wide route-boundary reads, marker-row churn, hotspot-engine rebuild rows, transaction wait/lock time, parking-charge rebuild CPU, vehicle-pricing callback duration and end-to-end latency. Profile normal changes, day-one early-arrival decisions, invalid-route validation and large-plan rebuilds separately before changing transaction timeouts, batching writes or parallelizing post-transaction work; preserve route-date ordering and billing-marker semantics.

The iteration-42 travel-replica boundary is a measurement seam for display-field normalization CPU, duration/distance fallback frequency, OSRM geometry calls, saved hotel-leg hits, source-leg fallback distance, hotspot-hotel map reads/writes, preview row churn and payload size. Profile matrix, OSRM-success, OSRM-fallback, hotel check-in and source-side workloads separately before caching geometry or changing fallback precedence; preserve matrix-duration metadata and display-label semantics.

The iteration-43 geometry boundary is a measurement seam for route-coordinate parse volume, projection segment count, OSRM geometry latency/failure rate, selected/destination endpoint query count, hotspot-hotel map reads/writes, Haversine fallback frequency and response CPU. Profile source-side, destination-side, hotel-endpoint, OSRM-success and OSRM-fallback workloads separately before adding a geometry cache or changing endpoint precedence; preserve coordinate ordering and city classification.

The timeline iteration-44 policy boundary is a measurement seam for candidate count by bucket/priority, closed-day filter volume, carry-forward merge/rejection counts, slot-policy calls, route-chain classification CPU, rejection-summary writes, proof-trace I/O and end-to-end rebuild latency. Profile normal, same-city continuation, carry-forward, closed-day and route-end-buffer workloads separately before changing policy ordering, logging volume, caching or candidate concurrency; preserve deterministic ordering and rejection metadata.

The timeline iteration-45 input-loading boundary is a measurement seam for plan/route/hotspot/timing query latency, rows returned, timing-map memory, all-days closed-hotspot reduction and repeated route-build read volume. Capture representative plan sizes and scoped-route previews before changing projections, batching, indexes or request-scoped caching; preserve active predicates, route ordering and transaction consistency.

## Next profiling order

1. Itinerary-details read graph and response projection.
2. Timeline builder repeated reads and candidate-evaluation loop boundaries.
3. Route-matrix and stored-location lookup fingerprints.
4. Hotel search/price cache access patterns.
5. Only then, index experiments or Redis implementation for the measured winner.

Related evidence: [`database-optimization-progress.md`](./database-optimization-progress.md), [`index-analysis.md`](./index-analysis.md), [`index-proposals.sql`](./index-proposals.sql), and [`database-audit-baseline.json`](./database-audit-baseline.json).
