# Service Decomposition Plan

This is an evidence-led plan; no production extraction is retained by the baseline tier.

| Current file | Observed size/calls | Cohesive responsibilities to investigate | Safe extraction order | Main risk |
|---|---:|---|---|---|
| `itineraries.service.ts` | 12,074 lines / 613 DB-call matches | create/update persistence; route/rebuild; manual/auto fit; hotel/vehicle/vendor pricing; confirmation/cancellation | guide assignment -> vehicle status -> vehicle orchestration -> plan persistence -> activity -> smart activity -> hotspot workflow -> selection workflow -> quote context -> confirmation -> hotel confirmation support -> hotel prebook -> hotel booking fulfillment -> confirmed-plan copy -> cancellation -> listing -> voucher reads -> manual matrix -> manual preview -> manual mutation -> manual fit matrix planning -> exact-anchor rebuild -> low-priority removal -> matrix-safe insertion -> preview timeline application -> route-leg cache -> manual batch -> insertion fit -> progressive removal -> adaptive insertion -> matrix-rescheduled preview -> matrix merge -> confirmed-details projection -> route timing -> manual-fit travel replica -> manual-fit geometry -> route/rebuild -> pricing | transaction and shared mutable state |
| `timeline.builder.ts` | 6,340 lines / 10 DB-call matches | route processing; travel legs; operating hours/cutoffs | pure timeline policy tests -> candidate policy -> input loader -> Day-1 fallback -> route-hotspot selection -> route-hotspot planning -> manual/same-city placement ordering -> destination reservation -> carry-forward attachment -> matrix autobuild -> candidate reordering -> Day-1 candidate gate -> Day-1 cutoff/master admission -> Day-1 travel projection -> arrival/hotel decisions -> hotel-first insertion -> non-hotel cutoff -> policy services | ordering/timing parity |
| `itinerary-details.service.ts` | 6,108 lines / 63 DB-call matches | data loading; response assembly; hotel details; activity/guide projections | read loaders -> response assembly | response shape and duplicate queries |
| `vendors.service.ts` | 3,478 lines / 161 DB-call matches | vendor CRUD; vehicles/slabs; local/outstation price books; permits; branches/lookups | lookup/read-only price-book query -> CRUD groups -> writes | shared Prisma model assumptions |
| `hotels.service.ts` | 2,945 lines / 139 DB-call matches | hotel CRUD; rooms/rate plans; amenities; price books; provider sync | pure normalization -> room/rate-plan reads -> writes -> providers | provider and transaction coupling |
| `activities.service.ts` | 2,607 lines / 94 DB-call matches | CRUD; timeslots; price book; reviews; provider/storefront | pure mapping -> read groups -> transactional writes | upload and booking side effects |
| `locations.service.ts` | 2,521 lines / 68 DB-call matches | stored locations; coordinates/distance; via routes; suggested routes; imports | pure distance/coordinate policy -> reads -> writes | direction-specific distance semantics |
| `hotspots.service.ts` | 1,225 lines / 62 DB-call matches | CRUD/form; timing; parking; gallery; priority | pure timing/parking -> form orchestration -> writes | multi-table atomic saves |

## Constraints

- Keep the existing service as a compatibility facade initially.
- Pass Prisma transaction clients explicitly when logic crosses a transaction boundary.
- Avoid `forwardRef()` until dependency redesign is exhausted.
- Add characterization tests before moving code.
- Do not optimize a query without before/after counts/timings and a stable test.
- Do not remove indexes without actual definitions, foreign-key analysis, usage counters and rollback SQL.

## Retained extraction

`ItineraryRouteNormalizationService` now owns route-chain normalization, terminal-anchor recognition, broken-chain detection and duplicate movable-stop filtering. `ItinerariesService` remains the compatibility facade and continues to own distance optimization and route DTO construction. The new service has no Prisma or external-provider dependency and is registered by `ItinerariesModule`.

`TimelineOperatingHoursService` now owns timing-value formatting, daily operating-window summaries and closed-day policy checks used by `TimelineBuilder`. `TimelineBuilder` remains the compatibility facade and still owns the broader timeline assembly and hotspot sequencing. The helper has no Prisma or external-provider dependency and is instantiated by the existing manually constructed builder.

`LocationGeoPolicyService` now owns coordinate parsing, location-name normalization, case-insensitive string deduplication, duration text formatting and haversine distance calculation used by `LocationsService`. `LocationsService` remains the Prisma/API compatibility facade and the policy service has no database dependency.

`TimelineTravelDataService` now owns timeline hotspot/hotel location reads, hotel detail enrichment, stored-location coordinate resolution and distance projections. `TimelineBuilder` remains the compatibility facade and receives the existing shared `DistanceHelper` explicitly. Query shape and transaction ownership are unchanged; endpoint-level measurement remains pending.

`TimelineCandidateFeasibilityService` now owns read-only candidate admission and anchor-gap timing checks. It receives explicit policy and distance dependencies, returns the existing rejection reasons, and leaves timeline orchestration and persistence in `TimelineBuilder`.

`ItineraryGuideAssignmentService` now owns guide availability, assignment read projections/options and guide pricebook/GST resolution. `ItinerariesService` remains the compatibility facade, and the new provider is registered by `ItinerariesModule`. Guide writes and confirmation/cancellation transaction workflows remain in the facade until their own evidence-backed tier.

`ItineraryVehicleBuildStatusService` now owns vehicle-build run IDs, in-memory status, status-table lifecycle, readiness counts and DB/memory/derived status resolution. `ItinerariesService` remains the compatibility facade and delegates status lifecycle calls. Vehicle-build orchestration, vendor auto-selection and manual-fit persistence remain separate concerns for subsequent tiers.

`ItineraryVehicleBuildService` now owns vehicle-build orchestration, stage timeout/retry handling, permit sync, plan vehicle context and lowest-cost active vendor selection. `ItinerariesService` remains the compatibility facade and keeps the final `selectVehicleVendor` mutation behind an explicit callback. Transaction ordering, SQL shape and response contracts are unchanged.

`ItineraryPlanPersistenceService` now owns the basic-info create/update transaction and reusable-template persistence. It receives explicit engine dependencies and callbacks for route optimization, same-city optimization and plan-edit reads; `ItinerariesService` remains the compatibility facade. Transaction ordering and response envelopes are unchanged.

`ItineraryActivityWorkflowService` now owns activity add, preview, delete and all-hotspots preview workflows. It receives the existing hotspot engine and explicit callbacks for activity pricing, impact, timing and conflict policies; `ItinerariesService` remains the compatibility facade. Smart activity preview and anchored local rebuild remain separate because they share movement/rebuild helpers.

`ItinerarySmartActivityService` now owns smart activity preview/apply-preview and insertion together with hotspot-gap movement, anchored local rebuild and preview timeline assembly. It receives explicit time/conflict policy callbacks; `ItinerariesService` retains the shared hotspot-duration helper used by other workflows. This boundary intentionally exceeds the preferred helper size because splitting the transaction/rebuild sequence would obscure rollback and ordering semantics.

`ItineraryHotspotWorkflowService` now owns hotspot availability, anchor-aware availability, add and preview workflows. It receives explicit location/time/manual-preview callbacks and the existing hotspot engine; `ItinerariesService` remains the compatibility facade. Query shape and response contracts are unchanged.

`ItinerarySelectionWorkflowService` now owns hotel discovery/selection, bulk hotel persistence, vehicle-vendor selection, slab selection/auto-selection and vehicle-pricing rebuilds triggered by hotspot changes. It receives the existing route and vehicle engines plus hotel cache service; `ItinerariesService` remains the compatibility facade. Selection preservation, rate validation and response contracts are unchanged.

`ItineraryQuoteContextService` now owns plan edit reads, customer form projection and wallet balance resolution. It keeps route/via/vehicle/traveller ordering, agent display formatting, wallet fallback arithmetic and validation behavior intact; `ItinerariesService` remains the compatibility facade. Confirmation transaction logic remains in the facade.

`ItineraryConfirmationService` now owns the quotation confirmation transaction, supplier-booking normalization and confirmation persistence preparation. It receives explicit callbacks for the remaining facade-owned hotel-draft synchronization, wallet, date-format and draft-copy helpers; `ItinerariesService` remains the compatibility facade. Post-confirmation provider booking orchestration remains in the facade until its own boundary is measured.

`ItineraryHotelConfirmationSupportService` now owns selected-hotel draft synchronization, confirmation financial finalization and already-successful supplier-booking filtering. It receives explicit callbacks for confirmation normalization/key policies and wallet resolution; `ItinerariesService` remains the compatibility facade. External provider booking calls remain outside this database-oriented boundary.

`ItineraryHotelPrebookService` now owns TBO hotel prebook request/response normalization and fresh booking-code resolution. It receives explicit normalization and provider-filter callbacks plus the existing TBO, room-details and supplement services; `ItinerariesService` remains the compatibility facade. Provider booking orchestration remains separate.

`ItineraryHotelBookingFulfillmentService` now owns post-confirmation supplier booking dispatch, already-confirmed filtering, provider result aggregation and final financial status updates. It receives explicit confirmation/helper callbacks and the existing provider services; `ItinerariesService` remains the compatibility facade. External provider calls remain outside database transactions.

`ItineraryConfirmedPlanCopyService` now owns transaction-scoped copying of vehicles, routes, via routes, hotels, activities, guides, vendor eligibility, vehicle details and permit charges from draft to confirmed plans. It has no facade callbacks and receives the transaction client explicitly; `ItinerariesService` remains the compatibility facade.

`ItineraryCancellationService` now owns cancellation validation, cancellation transaction persistence, child-service cleanup, supplier cancellation dispatch, audit logging and notifications. It receives the existing Prisma and hotel-provider services directly; `ItinerariesService` remains the compatibility facade.

`ItineraryListingService` now owns agent/location filter reads and confirmed, cancelled and accounts itinerary listing queries. It receives Prisma directly and retains date parsing, role scoping, search, pagination and response projection behavior; `ItinerariesService` remains the compatibility facade.

`ItineraryVoucherReadService` now owns hotel and transport voucher read projections, including label/date/location/passenger formatting through explicit callbacks. It receives Prisma directly and preserves missing-plan validation and response contracts; `ItinerariesService` remains the compatibility facade.

`ItineraryManualHotspotMatrixService` now owns missing manual-hotspot route-matrix construction and its concurrency lock. It receives Prisma and explicit city/location policy callbacks, preserving matrix result codes and validation behavior; `ItinerariesService` remains the compatibility facade.

`ItineraryManualHotspotPreviewService` now owns manual-hotspot preview/batch preview, snapshot rollback, preview-cache state, Fit Here preview/auto-fit and Fit Here confirmation entry points. It receives explicit transaction/policy callbacks and preserves controller-compatible wrappers in `ItinerariesService`.

`ItineraryManualHotspotMutationService` now owns manual-hotspot add and batch-apply orchestration. It receives Prisma, the hotspot engine and explicit timing/cleanup/rebuild/retry callbacks, preserving add response projection and batch transaction behavior; `ItinerariesService` remains the compatibility facade.

`ItineraryManualFitMatrixPlanningService` now owns detour-optimized anchor inference, matrix insertion-gap resolution and low-priority-removal timeline reconstruction. It receives Prisma and explicit timeline/route helper callbacks, preserving matrix slot decisions, travel reconnection and removal sanitization; `ItinerariesService` remains the compatibility facade.

`ItineraryExactAnchorRebuildService` now owns exact-anchor sequential timeline reconstruction after removals. It receives the transaction client explicitly, keeps its bounded reconstruction cache local and accepts shared city, operating-window, travel-replica and route-leg policies through callbacks; `ItinerariesService` remains the compatibility facade.

`ItineraryLowPriorityRemovalService` now owns matrix-overflow removal planning, active-route removal evidence, removal sanitization and attempt snapshot helpers. It receives Prisma and the transaction client explicitly, preserves combination-search/greedy ordering and delegates shared timeline/snapshot policies through callbacks; `ItinerariesService` remains the compatibility facade.

`ItineraryMatrixSafeInsertionService` now owns matrix-safe manual-hotspot insertion, active-row checks, route-local persistence, removal application and post-apply validation. It receives Prisma and the transaction client explicitly, preserves timing/route/preview callbacks and keeps the facade as the compatibility boundary.

`ItineraryPreviewTimelineApplicationService` now owns insertion projection, destination-side baseline pruning, pivot backtracking cleanup and destination-side preview rebuilding. It preserves row ordering, timing labels, city-direction classification and preview response shapes through explicit callbacks; `ItinerariesService` remains the compatibility facade.

`ItineraryRouteLegCacheService` now owns OSRM leg runtime caching, TTL/key normalization, reverse-leg lookup, provider fallback, stored-leg reads and distance/duration fallback helpers. It receives the existing Prisma client and the facade's route-geometry callback; `ItinerariesService` remains the compatibility facade. Cache freshness and provider behavior are unchanged.

`ItineraryManualHotspotBatchService` now owns the manual-hotspot batch transaction workflow, including matrix-fit decisions, adaptive scheduling, preview reconstruction, priority-removal rescue and final response assembly. It receives the existing hotspot engine and explicit facade policy callbacks; `ItinerariesService` remains the compatibility facade. Transaction ordering, rollback behavior and response envelopes are unchanged.

`ItineraryManualInsertionFitService` now owns manual insertion-fit reads and slot selection, including city-endpoint, single-hotspot, route-between-map, destination-hotel and timing-aware matrix decisions. It receives explicit facade data/policy callbacks; `ItinerariesService` remains the compatibility facade. Existing raw query filters, route-fit ranking and response metadata are unchanged.

`ItineraryProgressivePriorityRemovalService` now owns progressive same-route removal planning, candidate auditing, timing evaluation, exact-anchor rescue and priority-ordered simulation attempts. It receives explicit facade timeline, city, timing and snapshot callbacks; `ItinerariesService` remains the compatibility facade. Priority protection, removal ordering and final response metadata are unchanged.

`ItineraryAdaptiveManualHotspotInsertionService` now owns adaptive manual-hotspot set insertion, baseline and removal-assisted optimizer sequencing, protected-priority handling, preview simulation state and removal explanations. It receives explicit facade candidate, optimizer, priority and exclusion callbacks; `ItinerariesService` remains the compatibility facade. The successful optimizer path, removal ordering and confirmation metadata are unchanged.

`ItineraryMatrixRescheduledPreviewService` now owns matrix-rescheduled preview assembly, source/anchor/hotel leg reconstruction, timing rescheduling, duplicate-travel cleanup and final arrival metadata. It receives explicit facade timeline, duration, route-leg and saved-rule callbacks; `ItinerariesService` remains the compatibility facade. Matrix preview ordering, timing labels and response mutation behavior are unchanged.

`ItineraryConfirmedItineraryDetailsService` now owns confirmed-itinerary booked-hotel projection, provider booking normalization, hotel/master enrichment, room/meal labels and availability metadata. It receives Prisma directly and the existing guide-assignment callback; `ItinerariesService` remains the compatibility facade. Provider precedence, booking labels, cancellation flags and response envelopes are unchanged.

`ItineraryMatrixRescheduledPreviewService` also now owns matrix baseline merge and selected-row insertion preparation. The merge policy shares the reschedule service's explicit timing, row-duration, travel-label and finalization callbacks, so matrix preview assembly remains one transaction-aware boundary rather than two facade helpers.

`ItineraryRouteTimingService` now owns route start/end validation, route-boundary recalculation, previous-day billing markers, timeline rebuild and post-rebuild parking/vehicle pricing refresh. It receives Prisma and the hotspot engine directly plus the existing vehicle-pricing callback; `ItinerariesService` remains the compatibility facade. Transaction ordering, timing validation and response metadata are unchanged.

`ItineraryManualFitTravelReplicaService` now owns manual-fit travel display normalization, duration/distance labels, hotel check-in travel insertion, saved hotel-leg fallback, source-to-hotspot leg resolution and hotspot-hotel map support. It receives explicit route/OSRM, duration, timeline and hotel-map callbacks; `ItinerariesService` remains the compatibility facade for legacy route helpers. Display fields, fallback precedence and matrix metadata are unchanged.

`ItineraryManualFitGeometryService` now owns route-coordinate parsing, route projection, OSRM geometry, selected/destination hotel endpoint resolution and hotspot-to-hotel leg fallback. It receives explicit city-classification and duration callbacks; `ItinerariesService` remains the compatibility facade for legacy geometry callers. Coordinate normalization, endpoint precedence and OSRM fallback behavior are unchanged.

`TimelineCandidatePolicyService` now owns timeline timing-window adapters, slot decisions, carry-forward candidate ordering/merge, route-chain policy, rejection classification and candidate-evaluation reporting. It receives the existing operating-hours, slot, rejection and route policy services directly plus explicit logging/city callbacks; `TimelineBuilder` remains the orchestration facade. Candidate ordering, closed-day filtering, route buffers and rejection metadata are unchanged.

`TimelineDataAccessService` now owns the timeline plan, route, active-hotspot and active-timing reads plus timing-map construction. `TimelineBuilder` remains the orchestration facade and continues to own global-settings hydration, closed-hotspot filtering and scheduling state. Active predicates, route ordering, query order and transaction ownership are unchanged; query/index/cache optimization remains pending measurement.

`TimelineDay1SourceFallbackService` now owns the bounded Day-1 source-city priority fallback selection. It receives explicit city-matching callbacks and Prisma transaction access, while `TimelineBuilder` remains the compatibility facade. Priority/distance ordering, exclusion semantics and query predicates are unchanged; source-city selectivity and coordinate-read performance remain unmeasured.

`TimelineRouteHotspotSelectionService` now owns route-local hotspot context loading, timing-aware source/en-route/via/destination bucket selection, route-chain matching, distance ranking, exclusion handling and final candidate projection. It receives the shared distance helper and explicit route/city/coordinate/logging callbacks; `TimelineBuilder` remains the compatibility facade. Bucket precedence, ordering and response metadata are unchanged; query/index/cache optimization remains pending measurement.

`TimelineArrivalHotelDecisionService` now owns arrival-window evaluation, hotel-first/distance branching, early/late-arrival clock policy, report-cutoff suppression and Day-1 branch diagnostics. It receives the shared distance helper and explicit hotel/data/policy/logging callbacks; `TimelineBuilder` remains the compatibility facade and owns row insertion. Absolute timing, policy flags and route-clock updates are unchanged; decision and hotel-coordinate performance remain pending measurement.

`TimelineHotelFirstInsertionService` now owns the optional Day-1 hotel travel/check-in/rest row sequence, including check-in clamping and state updates. It receives the existing hotel and refreshment builders plus an explicit booking-rule logger; `TimelineBuilder` remains the compatibility facade. Eligibility gates, row order, time labels and transaction client usage are unchanged; insertion and provider latency remain pending measurement.

`TimelineNonHotelCutoffService` now owns the distance-backed latest non-hotel sightseeing cutoff calculation. It receives the shared distance helper and explicit city-normalization policy; `TimelineBuilder` remains the compatibility facade. Direct/final-route bypasses, buffer subtraction and formatted cutoff values are unchanged; provider/cache performance remains pending measurement.

`TimelineRouteHotspotPlanningService` now owns route-hotspot selection planning, via-route classification, Day-1 fallback selection, destination reservation guards and same-city carry-forward expiry. `TimelineBuilder` remains the compatibility facade and keeps closed-day filtering, candidate admission, travel rows, persistence and final timeline assembly. The service receives the transaction client and existing policy callbacks explicitly; query shape, ordering and transaction ownership are unchanged.

`TimelineManualPlacementOrderingService` now owns route-scoped preview membership, persisted route-order application, desired same-city movable ordering and manual hotspot merging. `TimelineBuilder` remains the compatibility facade and receives the returned ordering maps for later scheduling. The service has no database dependency; selection precedence, deterministic ordering and booking-rule diagnostics are unchanged.

`TimelineDestinationReservationService` now owns destination-loopback reservation feasibility, destination-bucket filtering, source fallback, empty-route rescue and reservation diagnostics. `TimelineBuilder` remains the compatibility facade and keeps explicit via/direct cleanup, carry-forward merging, matrix augmentation and timeline scheduling. The service receives transaction and policy callbacks explicitly; query shape, ordering and transaction ownership are unchanged.

`TimelineCarryForwardAttachmentService` now owns source-fallback-only classification and same-city carry-forward attachment. `TimelineBuilder` remains the compatibility facade and keeps matrix augmentation, candidate feasibility and timeline row scheduling. The service has no database dependency; suppression gates, merge arguments and scheduler-facing flags are unchanged.

`TimelineMatrixAutobuildService` now owns feature-flagged between-hotspot matrix augmentation, route-fit/corridor filtering, matrix scoring, timing admission and candidate merge. `TimelineBuilder` remains the compatibility facade and keeps candidate reordering, feasibility scheduling, travel rows and persistence. The service receives the transaction client and existing data/policy callbacks explicitly; the route-hotspot read, between-map query shape and transaction ownership are unchanged.

`TimelineCandidateReorderingService` now owns manual/positive-priority protection and matrix-score/distance ordering of selected candidates. `TimelineBuilder` remains the compatibility facade and keeps route scheduling, operating-hour evaluation, travel rows and persistence. The service has no database dependency; ordering and logging behavior are unchanged.

`TimelineDay1CandidateGateService` now owns Day-1 strict priority/filler filtering, terminal-arrival source suppression, duplicate protection and rejection diagnostics. `TimelineBuilder` remains the compatibility facade and keeps cutoff evaluation, hotspot-master reads, travel calculation, operating-hour scheduling and timeline row mutation. The service has no database dependency; movement exceptions and rejection ordering are unchanged.

`TimelineDay1CutoffMasterService` now owns Day-1 source/via/destination cutoff evaluation and prefetched hotspot-master admission. `TimelineBuilder` remains the compatibility facade and keeps coordinate resolution, travel calculation, projected-arrival checks, operating hours and timeline mutation. The service has no database dependency; cutoff thresholds, loopback bypass and rejection metadata are unchanged.

`TimelineDay1TravelProjectionService` now owns Day-1 source-coordinate fallback, hotspot travel-duration calculation, absolute/wrapped visit-time projection and route-end/projected-arrival rejection logging. `TimelineBuilder` remains the compatibility facade and keeps operating-hours evaluation, waiting policy and timeline row mutation. Provider callbacks and transaction ownership are unchanged; coordinate fallback, travel-provider and projected-arrival latency remain pending measurement.
