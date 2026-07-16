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

## Iteration 68 evidence update

- The manual-fit timeline-policy extraction is pure orchestration/policy work; it preserves existing timeline validation, removal filtering, retry classification and exact-anchor projection without SQL, index, Redis cache or query-shape changes.
- The facade still supplies the existing segment-time callback and all manual-fit services retain their callback names and ordering; only policy ownership moved.
- This is not a measured performance improvement: policy CPU, row volume, diagnostic frequency, retry frequency, cacheability and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must be based on representative preview traces and preserve timeline invariants and response metadata.

## Iteration 69 evidence update

- The matrix-preview timeline-policy extraction is pure response/timing policy work; it preserves existing timeline row processing without SQL, index, Redis cache or query-shape changes.
- Existing time/duration callbacks, travel-label projection, placeholder repair, duplicate suppression and matrix-order diagnostics remain unchanged; only policy ownership moved.
- This is not a measured performance improvement: policy CPU, placeholder frequency, duplicate volume, diagnostic frequency and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must use representative matrix-preview traces and preserve time formatting and ordering contracts.

## Iteration 70 evidence update

- The manual-fit removal-explanation extraction is pure presentation/policy work; it preserves existing removal evidence and response assembly without SQL, index, Redis cache or query-shape changes.
- Attraction-only attempt enrichment, reason precedence, priority ordering and changes-required response fields remain unchanged; only ownership moved behind a provider with facade callbacks.
- This is not a measured performance improvement: explanation CPU, removal-row volume, payload size, diagnostic frequency and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must use representative removal-report traces and preserve evidence precedence and response contracts.

## Iteration 71 evidence update

- The manual-fit route-policy extraction is pure route-fit/city classification work; it preserves existing slot eligibility and response metadata without SQL, index, Redis cache or query-shape changes.
- Route-fit ranks/labels, relaxed manual timing rules, empty-route eligibility, normalized city keys and source/destination classification remain unchanged; only policy ownership moved.
- This is not a measured performance improvement: policy CPU, candidate volume, classification frequency, suggestion generation and response latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must use representative route-fit traces and preserve eligibility precedence and metadata contracts.

## Iteration 72 evidence update

- The travel-replica helper consolidation preserves in-memory timeline scans and existing callback reads; no SQL, index, Redis cache or query shape was changed.
- Replica key precedence, duration fallbacks, distance parsing and check-in label extraction remain unchanged; only ownership moved into the existing travel-replica service.
- This is not a measured performance improvement: map-build CPU, key hit/miss rates, fallback frequency, payload size and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare representative replica traces and preserve key precedence and display contracts.

## Iteration 73 evidence update

- The saved-rule travel-leg consolidation preserves the existing transaction-scoped hotspot/route/hotel reads and distance-helper calls; no SQL, index, Redis cache or query shape was changed.
- Travel-location classification, endpoint predicates, buffer inclusion and leg response fields remain unchanged; only ownership moved into the existing travel-replica service.
- This is not a measured performance improvement: endpoint latency, read fan-out, distance-helper latency, missing-endpoint rate, buffer frequency and transaction volume remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare leg-specific traces and preserve transaction scope and travel semantics.

## Iteration 74 evidence update

- The route-matrix persistence extraction preserves hotspot-place identity reads/upserts, route-between SQL, rejection lookup and source-anchor reads; no SQL, index, Redis cache or query shape was changed.
- Transaction client usage, mirrored route-key predicates, route-fit thresholds, OSRM callbacks and source-anchor ordering remain unchanged; only orchestration ownership moved.
- This is not a measured performance improvement: raw query latency, row volume, OSRM latency, geometry CPU, candidate volume and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route-map hit/insert and source-anchor traces, including write amplification and lock risk.

## Iteration 75 evidence update

- The manual-fit operating-hours extraction preserves route-date and hotspot-timing reads, active predicates and ordering; no SQL, index, Redis cache or query shape was changed.
- Overnight-window handling, opening waits, closing overflow, conflict marking and response fields remain unchanged; only policy ownership moved into a Prisma-backed service.
- This is not a measured performance improvement: timing-row fan-out, selectivity, parsing CPU, conflict frequency, payload size and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare timing-row query plans across no-timing, single-window, multi-window and overnight workloads while preserving mutable-hours freshness.

## Iteration 76 evidence update

- The manual-fit validation extraction preserves in-memory distance comparisons and operating-hours/route-end callbacks; no SQL, index, Redis cache or query shape was changed.
- Detour thresholds, candidate ordering, conflict reason precedence, relaxed off-route handling and apply-readiness fields remain unchanged; only policy ownership moved.
- This is not a measured performance improvement: slot-insight CPU, distance-helper call volume, validation latency, conflict frequency, overflow frequency and payload size remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare candidate-count and distance-call traces while preserving mutable timing freshness and validation precedence.

## Iteration 77 evidence update

- The manual-fit schedule-attempt extraction preserves in-memory timeline scans and existing distance/timing callbacks; no SQL, index, Redis cache or query shape was changed.
- Travel totals, protected-priority detection, exact-anchor overlap handling, attempt category precedence and tie-breakers remain unchanged; only policy ownership moved.
- This is not a measured performance improvement: scan CPU, distance-helper calls, attempt volume, comparison latency, overlap frequency and strategy-selection latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare attempt traces and distance-call counts before memoizing candidate metrics while preserving schedule semantics.

## Iteration 78 evidence update

- The manual-fit candidate-simulation extraction preserves the existing transaction-scoped rebuild, candidate, schedule-state and timeline reads; no SQL, index, Redis cache or query shape was changed.
- Exact-anchor recovery order, operating-hours enrichment, score inputs, priority confirmation, timing counts and candidate response fields remain unchanged; only orchestration ownership moved.
- This is not a measured performance improvement: per-position query fan-out, rebuild latency, timeline read latency, enrichment latency, score CPU, unscheduled frequency and preview latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare per-position traces and transaction duration before batching or caching mutable timeline data.

## Iteration 79 evidence update

- The manual-fit candidate-search extraction preserves route lookup, candidate reads, per-position simulation and selected-position rebuild callbacks; no SQL, index, Redis cache or query shape was changed.
- Preferred/exact/source/destination position precedence, slot insights, fallback envelopes, strategy ordering and optimizer metadata remain unchanged; only orchestration ownership moved.
- This is not a measured performance improvement: position CPU, candidate count, per-position fan-out, route-read latency, strategy count, rebuild latency and end-to-end search latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare candidate and strategy traces before reducing attempts or caching mutable route state.

## Iteration 80 evidence update

- The manual-fit candidate-data extraction preserves route-hotspot, hotspot-master and active-timing reads, predicates, ordering and transaction client usage; no SQL, index, Redis cache or query shape was changed.
- Timing-window formatting, open-24-hours precedence, manual priority projection, duration fields and classification output remain unchanged; only read projection ownership moved.
- This is not a measured performance improvement: read latency, timing-row fan-out, selectivity, formatting CPU, candidate count and input-assembly latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route/master/timing query plans and mutable-hours freshness before batching or caching.

## Iteration 81 evidence update

- The manual-hotspot row extraction preserves exclusion-list reads/writes, manual-row lookup predicates, stale-row updates and placeholder creation; no SQL, index, Redis cache or query shape was changed.
- Duplicate exclusion handling, valid-row reuse, positive-duration checks, conflict handling, placeholder timestamps and user attribution remain unchanged; only persistence ownership moved.
- This is not a measured performance improvement: exclusion write latency, duplicate rate, valid-row reuse rate, stale-row count, placeholder frequency and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare row-lifecycle traces and lock/write amplification before batching or caching mutable route state.

## Iteration 82 evidence update

- The manual-hotspot schedule-state extraction preserves route-hotspot, route-date and active-timing predicates, weekday conversion, normal/overnight window handling and overlap callbacks; no SQL, index, Redis cache or query shape was changed.
- Positive-duration filtering, conflict rejection, no-date/no-timing permissive fallback and timing order remain unchanged; only schedule-state ownership moved.
- This is not a measured performance improvement: schedule-state read latency, timing-row fan-out, weekday selectivity, overnight frequency, overlap-query cost and permissive-fallback frequency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route/date/timing query plans and overlap traces across normal, overnight and fallback workloads while preserving mutable operating-hours freshness.

## Iteration 83 evidence update

- The manual-hotspot row-timing extraction preserves active-row predicates, positive-duration validation, newest-row ordering, duplicate retirement, update/create fields and transaction client usage; no SQL, index, Redis cache or query shape was changed.
- Stale-row status/deleted transitions, UTC duration representation, conflict reset, timestamps and returned row identity remain unchanged; only row-timing ownership moved.
- This is not a measured performance improvement: stale-row scan volume, duplicate frequency, update/create ratio, write amplification, lock duration and activation latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare stale-row and activation traces with lock/write costs before batching or caching mutable route state.

## Iteration 84 evidence update

- The manual-hotspot overlap extraction preserves route/plan/item/deleted predicates, time parsing, invalid-window handling, conflict-row exclusion and half-open overlap comparison; no SQL, index, Redis cache or query shape was changed.
- Non-overlapping-row short-circuiting and existing transaction-client usage remain unchanged; only overlap-policy ownership moved.
- This is not a measured performance improvement: overlap query latency, active-row fan-out, conflict-row frequency, candidate short-circuit rate and selection CPU remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare overlap query plans and row-count traces before batching or caching mutable route state.

## Iteration 85 evidence update

- The forced manual-hotspot conflict extraction preserves existing-row lookup predicates, route-time fallback reads, order lookup, update/create fields and transaction client usage; no SQL, index, Redis cache or query shape was changed.
- Preferred timing precedence, minimum fallback duration, conflict reason, status/deleted fields, timestamps and created-by semantics remain unchanged; only conflict persistence ownership moved.
- This is not a measured performance improvement: existing-row lookup latency, route-order lookup latency, update/create ratio, fallback frequency, conflict-write volume and transaction duration remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare conflict lookup/order query plans and write traces before batching or caching mutable route state.

## Iteration 86 evidence update

- The route-hotspot rebuild extraction preserves active-route validation, route/date and existing-hotspot reads, manual activity/row retirement, exclusion clearing, hotspot-engine transaction scope and post-transaction side effects; no SQL, index, Redis cache or query shape was changed.
- Plan-wide existing-hotspot snapshotting, clean-route skip behavior, transaction timeout/wait settings, parking rebuild and vehicle-pricing refresh remain unchanged; only workflow ownership moved.
- This is not a measured performance improvement: route/date/hotspot read fan-out, transaction duration, rebuild row volume, skipped-route frequency, parking-charge latency and pricing-refresh latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare route-rebuild query plans and transaction traces before batching or caching mutable itinerary state.

## Iteration 87 evidence update

- The hotel-cancellation extraction preserves confirmed-plan, route, hotel and room predicates, audit fallback, soft-delete ordering, plan financial updates and account refund updates; no SQL, index, Redis cache or query shape was changed.
- Cancellation projection fields, percentage rounding, refund clamp, transaction scope and missing-plan/hotel errors remain unchanged; only cancellation ownership moved.
- This is not a measured performance improvement: route/hotel/room read fan-out, row volume, audit fallback frequency, soft-delete write volume, transaction duration and refund-accounting latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare cancellation read/write traces and lock duration before batching or caching mutable confirmed-itinerary state.

## Iteration 88 evidence update

- The room-category extraction preserves plan/route reads, TBO room retrieval, hotel/group matching, room-type projection, existing-room predicates and update/create writes; no SQL, index, Redis cache or query shape was changed.
- Preferred-room slot fallback, room-rate assignment, meal-plan flags, GST defaults, deleted/status fields and response fields remain unchanged; only room-category ownership moved.
- This is not a measured performance improvement: TBO latency, room-type count, existing-room fan-out, preferred-slot frequency, update/create ratio and selection write latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare TBO and room-row traces before batching or caching mutable room selections.

## Iteration 89 evidence update

- The route-optimization extraction preserves exact stored-distance predicates, missing-distance Infinity fallback, route-normalization inputs and active permutation/annealing policy; no SQL, index, Redis cache or query shape was changed.
- Small-route exhaustive threshold, larger-route heuristic selection, route date/sequence projection and original-order fallback remain unchanged; the facade retains an untouched compatibility helper copy pending encoding-safe cleanup.
- This is not a measured performance improvement: stored-distance latency, distance-row fan-out, permutation count, matrix miss rate, annealing CPU and end-to-end optimizer latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare stored-distance query plans and optimizer traces before batching or caching route geometry.

## Iteration 90 evidence update

- The activity-impact extraction preserves activity, route-hotspot, route and downstream-hotspot predicates, hotspot-master priority reads and rollback-only rebuild behavior; no SQL, index, Redis cache or query shape was changed.
- Activity-duration fallback, extension calculation, priority warning/removal ordering, route-end decision and rollback marker semantics remain unchanged; concrete DI tokens additionally restore Nest startup without changing runtime contracts.
- This is not a measured performance improvement: activity/hotspot/route read fan-out, downstream row volume, master lookup latency, priority-removal frequency, reroute fallback frequency and simulation latency remain unmeasured.
- No index or Redis action is proposed; any future optimization must compare impact query plans and downstream simulation traces before batching or caching mutable route state.

## Iteration 91 evidence update

- The transport-formatting extraction changes only helper ownership and facade delegation; no SQL, index, Redis cache or query shape was changed.
- Voucher date/range formatting, passenger labels, time/location normalization, HTML decoding, JSON/raw parsing and fallback fields remain unchanged; the facade's existing time-format callback remains the source of transport time labels.
- This is not a measured performance improvement: formatting CPU, payload size, malformed-payload frequency, fallback frequency and transport voucher projection latency remain unmeasured.
- No index or Redis action is proposed; any future optimization should compare payload-shape traces and projection CPU before adding memoization or caching mutable voucher data.

## Iteration 92 evidence update

- The activity-pricing extraction preserves plan, route, country and activity-pricebook predicates, select fields, dated lookup and day-one fallback; no SQL, index, Redis cache or query shape was changed.
- Nationality classification, passenger counts, rate precedence, unit/per-adult selection, totals and price-date fields remain unchanged; transaction-client pass-through is preserved.
- This is not a measured performance improvement: context-read latency, country-read latency, pricebook selectivity, fallback frequency, row count and availability fan-out remain unmeasured.
- No index or Redis action is proposed; any future optimization should compare pricebook query plans and per-activity read traces before batching or caching mutable pricing data.

## Iteration 93 evidence update

- The activity-timing extraction changes only policy ownership and callback delegation; no SQL, index, Redis cache or query shape was changed.
- UTC conversion, display formatting, minute arithmetic, no-slot handling, slot-fit checks, warning text and severity remain unchanged.
- This is not a measured performance improvement: timing-policy CPU, activity-slot row count, conflict frequency and warning projection latency remain unmeasured.
- No index or Redis action is proposed; any future optimization should compare timing-row counts and conflict traces before batching or caching mutable timing data.

## Iteration 94 evidence update

- The timeline build-context extraction preserves plan, route, hotspot and timing predicates, route ordering, timing-map construction and global-settings lookup; no SQL, index, Redis cache or query shape was changed.
- Route scoping, previous-route mapping, hotspot lookup projection, permanently-closed filtering, evidence logging and early-return behavior remain unchanged.
- This is not a measured performance improvement: context-read latency, row volume, global-settings latency, map-build CPU and closed-hotspot filtering latency remain unmeasured.
- No index or Redis action is proposed; any future optimization should compare query plans and context traces before batching or caching mutable timing/hotspot state.

## Iteration 95 evidence update

- The itinerary-details timeline-presentation extraction changes only pure segment transformation ownership; no SQL, index, Redis cache or query shape was changed.
- Attraction visit-time protection, overnight handling, break/travel chronology adjustment, semantic-stop precedence and travel response fields remain unchanged.
- This is not a measured performance improvement: segment count, normalization CPU, adjustment frequency, label-reconstruction CPU and response projection latency remain unmeasured.
- No index or Redis action is proposed; any future optimization should profile the details read graph and segment projection before batching database reads or caching mutable itinerary responses.

## Iteration 96 evidence update

- The TBO cache extraction preserves cache key construction, five-minute TTL behavior, bounded eviction, quote invalidation and stats; no SQL, index or query shape was changed.
- Provider request construction, response projection and explicit cache invalidation entry points remain unchanged; Redis was not introduced.
- This is not a measured performance improvement: hit rate, expiry rate, eviction frequency, provider-call reduction and hotel response latency remain unmeasured.
- No index addition/removal or Redis action is proposed until cache/provider traces justify a measured change.

## Iteration 97 evidence update

- The frontend hotel-list normalization extraction changes only pure presentation ownership; no backend SQL, index, Redis cache, API request or response shape changed.
- Meal-plan precedence, amount rounding, date locale, inclusion-list parsing, star-category parsing and supplier fallback behavior remain unchanged.
- This is not a measured database performance improvement: component render time, normalization CPU, bundle contribution and supplier-row projection cost remain unmeasured.
- No index or Redis action is proposed; future work should profile HotelList render boundaries and bundle composition before memoization or additional UI extraction.

## Iteration 98 evidence update

- The vehicle-pricing policy extraction changes only pure slab-selection ownership; no SQL, index, Redis cache, stored-location predicate or vehicle-cost response shape changed.
- Numeric coercion, title-derived time limits, deterministic slab ordering, selected-slab coverage, upgrade flags and over-range fallback remain unchanged.
- This is not a measured database performance improvement: local pricebook row counts, pricebook query latency, slab CPU and vehicle-cost projection latency remain unmeasured.
- No index or Redis action is proposed; future work should capture pricebook query plans and slab-selection traces before batching, memoizing or caching mutable pricing data.

## Iteration 99 evidence update

- The vendor pricebook policy extraction changes only pure normalization and soft-delete marker ownership; no SQL, index, Redis cache, active predicate or vendor response shape changed.
- Explicit limit precedence, title-derived fallback, normalized title preservation and positive soft-delete sequencing remain unchanged.
- This is not a measured database performance improvement: limit lookup latency, pricebook row counts, sibling-row scan volume and write amplification remain unmeasured.
- No index or Redis action is proposed; future work should capture vendor pricebook query plans and deletion mutation traces before batching or caching mutable limit state.

## Iteration 100 evidence update

- The itinerary input-normalization extraction changes only pure facade policy ownership; no SQL, index, Redis cache, API route, DTO or response shape changed.
- CSV/date fallback, route-family quote parsing, array/string normalization, meal-plan precedence and manual-hotspot positive-ID filtering remain unchanged.
- This is not a measured database performance improvement: normalization CPU, callback payload shaping, downstream query selectivity and response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile the input-to-query boundary before batching or caching mutable itinerary request state.

## Iteration 101 evidence update

- The collaborator-wiring extraction changes only constructor callback ownership; no SQL, index, Redis cache, API route, DTO, transaction boundary or response shape changed.
- Callback names, service ordering, facade-bound helper dispatch and mutable service instances remain unchanged.
- This is not a measured database performance improvement: initialization time, callback fan-out, downstream query latency and first-request readiness remain unmeasured.
- No index or Redis action is proposed; future work should profile dependency initialization and callback invocation traces before changing service boundaries.

## Iteration 102 evidence update

- The timeline direct-delegation extraction changes only ownership of existing service calls; no SQL, index, Redis cache, predicate, transaction boundary or response shape changed.
- Route selection, Day-1 fallback, travel-data coordinate resolution, anchor calculations and candidate-feasibility arguments remain unchanged.
- This is not a measured database performance improvement: route/travel query latency, row volume, direct-call overhead and timeline projection CPU remain unmeasured.
- No index or Redis action is proposed; future work should capture route/travel query plans and timeline traces before batching or caching mutable timing/location data.

## Iteration 103 evidence update

- The itinerary-details time-range extraction changes only pure display-time and duration policy ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- 12-hour parsing, UTC duration conversion, overnight ordering, equal-end travel derivation and duration labels remain unchanged.
- This is not a measured database performance improvement: policy CPU, duration-source frequency, details projection cost and end-to-end response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile the itinerary-details read graph and response projection before memoizing policy calls or caching mutable itinerary data.

## Iteration 104 evidence update

- The itinerary-details display-formatting extraction changes only pure date, clock and duration presentation ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- UTC wall-clock labels, date-only extraction, created-on formatting, duration fallbacks and two-digit padding remain unchanged.
- This is not a measured database performance improvement: formatter CPU, invalid-input frequency, response projection cost and end-to-end details latency remain unmeasured.
- No index or Redis action is proposed; future work should profile details response projection and formatter hot paths before memoizing or caching mutable itinerary data.

## Iteration 105 evidence update

- The route-hotel-map extraction preserves the existing draft/confirmed hotel queries, active/deleted predicates, group selection, TBO fallback reads and response-map precedence; no SQL predicate, index, Redis cache or response shape changed.
- Local master enrichment, provider-code fallback, route-map construction and vehicle-only labeling remain behaviorally unchanged.
- This is not a measured database performance improvement: hotel lookup latency, row selectivity, TBO fan-out, map CPU and details response latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture query plans and hotel lookup traces before batching or caching mutable hotel assignments.

## Iteration 106 evidence update

- The travel-semantics extraction changes only pure timeline projection ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- Attraction sequence ordering, conflict-row suppression, prior-hotel check-in handling, semantic IDs and travel labels remain unchanged.
- This is not a measured database performance improvement: route-hotspot scan cost, semantic CPU, travel-row volume and details response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile route timeline row volume and semantic projection before memoizing or caching mutable timeline data.

## Iteration 107 evidence update

- The route-hotspot-data extraction preserves the existing raw SQL fields, route/plan/status/deleted predicates, hotspot master/timing/gallery predicates, ordering and response maps; no SQL predicate, index, Redis cache or response shape changed.
- Chronological sort tie-breaks, lookup-name normalization, timing grouping, gallery URL construction and empty-route short-circuits remain unchanged.
- This is not a measured database performance improvement: route-hotspot latency, row volume, reference-data fan-out, map CPU and details response latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture route-hotspot query plans and row-volume traces before batching or caching mutable hotspot data.

## Iteration 108 evidence update

- The entry-ticket cost extraction preserves the plan-scoped active/status/deleted predicates, selected fields, ascending order, numeric normalization and grouped response map; no SQL predicate, index, Redis cache or response shape changed.
- Positive route-hotspot filtering and traveller-cost ordering remain unchanged.
- This is not a measured database performance improvement: cost-row latency, row volume, grouping CPU and entry-ticket response projection latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture cost-row query plans and row-volume traces before batching or caching mutable entry-ticket data.

## Iteration 109 evidence update

- The latest DataTable extraction preserves request fallback precedence, role/search predicates, date/location filters, selected fields, confirmation exclusion, pagination and row response shape; no SQL predicate, index, Redis cache or API contract changed.
- Staff/agent/user hydration, username-label precedence and date formatting remain unchanged.
- This is not a measured database performance improvement: role/search lookup latency, query fan-out, plan-row volume, projection CPU and endpoint latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture DataTable query plans and endpoint traces before batching or caching mutable listing data.

## Iteration 110 evidence update

- The segment-sanitizer extraction changes only pure response projection ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- Excluded IDs/names, generic hotel no-op removal, same-place travel suppression and unrelated segment retention remain unchanged.
- This is not a measured database performance improvement: sanitizer CPU, rejected-row frequency, segment volume and details response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile timeline projection and exclusion frequency before memoizing or caching mutable itinerary data.

## Iteration 111 evidence update

- The destination-resolution extraction changes only pure timeline policy ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- Conflict/attraction/hotel skipping, via-route fallback, Hotel substitution, exact matching and partial matching remain unchanged.
- This is not a measured database performance improvement: destination scan CPU, master lookup frequency, label-match CPU and details response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile route timeline scans and hotspot-label match frequency before memoizing or caching mutable itinerary data.

## Iteration 112 evidence update

- The segment-ordering extraction changes only pure timeline presentation ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- Clock parsing, type precedence, same-minute travel/attraction tie-breaks and CTA reinsertion remain unchanged.
- This is not a measured database performance improvement: ordering CPU, CTA volume, overlap frequency and details response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile timeline segment counts and ordering hot paths before memoizing or caching mutable itinerary data.

## Iteration 113 evidence update

- The hotel-first placement extraction changes only pure timeline presentation ownership; no SQL, index, Redis cache, predicate, API route or response shape changed.
- Hotel-name normalization, check-in/travel clock comparison, start placement and fallback insertion remain unchanged.
- This is not a measured database performance improvement: policy CPU, reorder frequency, segment volume and details response latency remain unmeasured.
- No index or Redis action is proposed; future work should profile hotel-first timeline traces before memoizing or caching mutable itinerary data.

## Iteration 114 evidence update

- The source-travel extraction preserves destination fallback, Hotel substitution, same-place suppression, distance-resolver arguments, CTA insertion and travel response fields; no SQL predicate, index, Redis cache or response shape changed.
- Returned distance/previous-stop/pre-attraction state preserves the surrounding loop behavior.
- This is not a measured database performance improvement: distance latency, no-op frequency, source-travel row volume and details response latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture distance lookup plans and route-row traces before batching or caching mutable travel data.

## Iteration 115 evidence update

- The via-travel extraction preserves via-location selection, distance-resolver arguments, CTA insertion, travel fields and accumulation state; no SQL predicate, index, Redis cache or response shape changed.
- Via-row timing and mutable route-location freshness remain unchanged.
- This is not a measured database performance improvement: via-row volume, distance latency, CTA frequency and details response latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture via-route and distance lookup traces before batching or caching mutable travel data.

## Iteration 116 evidence update

- The regular semantic-travel extraction preserves semantic/fallback precedence, forced-manual conflict injection, Hotel correction, lookahead, hotspot-ID inference, distance resolver arguments, CTA insertion and travel response fields; no SQL predicate, index, Redis cache or response shape changed.
- Returned state preserves previous-stop, attraction flag, pre-attraction flag and distance accumulation semantics.
- This is not a measured database performance improvement: lookahead CPU, conflict frequency, distance latency, row volume and details response latency remain unmeasured.
- No index addition/removal or Redis action is proposed; future work should capture semantic/distance traces before batching or caching mutable timeline travel data.
