# Database Model Usage

Initial static inventory captured from `prisma/schema.prisma` and active source call sites on 2026-07-16.

- Prisma models: 180
- `@@index`/`@@unique` declarations: 2,017 matches (includes all declarations found by the source scan; validate exact generated SQL before decisions)
- Datasource: MySQL
- High-risk read/write owners: itinerary plan/routes/hotspots/hotels/vehicles; vendor price books and permits; activity price books; stored locations and route distances.

## Ownership map

| Domain | Active owners | Common access patterns | Performance evidence status |
|---|---|---|---|
| Itinerary | `ItinerariesService`, engines, details service | plan/route IDs, status/deleted, ordered dates, nested projections | static scan only |
| Hotels | `HotelsService`, hotel search/confirm/provider services | hotel/city/status, room/rate-plan joins, date ranges | static scan only |
| Vendors | `VendorsService`, vehicle engines | vendor/status, vehicle type, price-book dimensions, permits | static scan only |
| Activities | `ActivitiesService` | hotspot/activity/status, timeslots, price books | static scan only |
| Locations | `LocationsService` | city/name/status, route endpoints, coordinates | static scan only |
| Hotspots | `HotspotsService`, itinerary engines | location/status/opening hours/priority, route assignments | static scan only |

Actual table sizes, index definitions, foreign-key support, usage counters, query plans and digest timings require the read-only audit against an isolated or explicitly approved database.

## Read-only audit result

Generated on 2026-07-16 from the configured local `dvi_main` database; raw evidence is in `database-audit-baseline.json`.

- Tables returned by `information_schema.TABLES`: 182
- Index-column definitions returned by `information_schema.STATISTICS`: 2,288
- Declared foreign-key relationships returned by `information_schema.KEY_COLUMN_USAGE`: 0
- Performance Schema: enabled; index-I/O counters available
- No DDL/DML was executed, and no endpoint query count or latency is inferred from this audit
