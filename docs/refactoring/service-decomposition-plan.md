# Service Decomposition Plan

This is an evidence-led plan; no production extraction is retained by the baseline tier.

| Current file | Observed size/calls | Cohesive responsibilities to investigate | Safe extraction order | Main risk |
|---|---:|---|---|---|
| `itineraries.service.ts` | 32,159 lines / 613 DB-call matches | create/update persistence; route/rebuild; manual/auto fit; hotel/vehicle/vendor pricing; confirmation/cancellation | guide assignment -> vehicle status -> vehicle orchestration -> plan persistence -> activity -> smart activity -> hotspot workflow -> selection workflow -> manual preview boundary -> route/rebuild -> pricing -> confirmation | transaction and shared mutable state |
| `timeline.builder.ts` | 9,182 lines / 35 DB-call matches | input loading; route processing; hotspot selection; travel legs; operating hours/cutoffs | pure timeline policy tests -> input loader -> policy services | ordering/timing parity |
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
