# Service Decomposition Plan

This is an evidence-led plan; no production extraction is retained by the baseline tier.

| Current file | Observed size/calls | Cohesive responsibilities to investigate | Safe extraction order | Main risk |
|---|---:|---|---|---|
| `itineraries.service.ts` | 37,413 lines / 607 DB-call matches | create/update persistence; route/rebuild; manual/auto fit; hotel/vehicle/vendor pricing; confirmation/cancellation | pure calculations -> manual preview boundary -> route/rebuild -> pricing -> confirmation | transaction and shared mutable state |
| `timeline.builder.ts` | 10,398 lines / 49 DB-call matches | input loading; route processing; hotspot selection; travel legs; operating hours/cutoffs | pure timeline policy tests -> input loader -> policy services | ordering/timing parity |
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
