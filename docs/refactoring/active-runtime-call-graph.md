# Active Runtime Call Graph

Captured from the working tree on 2026-07-16. The backend repository is `api.dvi.travel`; the frontend repository is the sibling `dvi_frontend`.

## Runtime boundaries

- REST prefix: `/api/v1` (`api.dvi.travel/src/main.ts`)
- GraphQL exception: `/api/v2/graphql`
- Frontend itinerary routes: `/itinerary-details/:id` and `/confirmed-itinerary/:id` (`dvi_frontend/src/App.tsx`)
- Edit/details route component: `ItineraryDetailsRouter` -> lazy `ItineraryDetails` -> `ItineraryDetailsController`
- Confirmed route component: `ConfirmedItineraryDetails`
- Frontend API boundary: `dvi_frontend/src/services/itinerary.ts` (`ItineraryService`)
- Backend itinerary controller: `src/modules/itineraries/itineraries.controller.ts`
- Backend orchestration and domain providers: `ItinerariesService`, `ItineraryDetailsService`, hotel/voucher/route/optimizer services, and itinerary engines registered by `ItinerariesModule`.

## Critical flows

| Flow | Frontend entry/API methods | Backend route/controller | Main service boundary | Persistence/external boundary |
|---|---|---|---|---|
| Itinerary create/save/edit | `create`, `update`, `getOne` | `POST /itineraries`, `GET /itineraries/edit/:id`, `GET /itineraries/:id` | `ItinerariesService` | itinerary plan/routes/vehicles/travellers models; route and vehicle engines |
| Itinerary details | `getDetails` | `GET /itineraries/details/:quoteId` | `ItineraryDetailsService` | plan/routes/hotspots/hotels/activities and related Prisma reads |
| Hotel details/rebuild | `getHotelDetails`, `rebuildHotelDetails` | `GET/POST /itineraries/hotel_details/:quoteId[/rebuild]` | hotel detail services + `ItinerariesService` | hotel/rate/price-book models; provider services where selected |
| Timeline generation | details/rebuild/manual-fit methods | details, rebuild, manual-hotspot routes | `timeline.builder.ts`, itinerary engines | route/hotspot/location tables; timing and distance logic |
| Hotspot allocation | `getAvailableHotspots`, `addHotspot`, `previewAddHotspot` | `/itineraries/hotspots/*` | `ItinerariesService`, hotspot engine | route hotspot rows; stored locations and distance data |
| Manual hotspot preview/confirm | `addManualHotspot`, fit preview/confirm/apply methods | `POST /itineraries/:id/manual-hotspot*`, `/manual-hotspots/apply` | `ItinerariesService` | preview is expected to be non-persistent; confirm/apply persists route hotspot state |
| Vehicle build/pricing | vehicle selection/build methods | `/itineraries/vehicles/*`, `/:planId/vehicle-build*` | vehicle engines and `ItinerariesService` | vendor/vehicle/price-book/permit rows; async build state |
| Hotel selection/pricing | `getAvailableHotels`, `selectHotel`, `prebookHotels` | `/itineraries/hotels/*` | hotel services and `ItinerariesService` | hotel room/rate-plan/price-book rows; provider booking services |
| Vendor selection | vendor/vehicle API methods | `/vendors/*`, itinerary vehicle routes | `VendorsService`, itinerary vehicle services | vendor, vehicle, slab, permit, branch tables |
| Confirmation/cancellation | `confirmQuotation`, `cancelItinerary` | `/itineraries/confirm-quotation`, `/cancel` | `ItinerariesService`, voucher/payment services | account, ledger, voucher, booking, wallet/payment rows |
| Administration masters | frontend admin pages and service modules | `/hotels`, `/vendors`, `/activities`, `/locations`, `/hotspots` | corresponding oversized CRUD service | master tables and soft-delete/status fields |
| Provider synchronization | scheduled/import scripts and provider modules | provider controllers/jobs | provider-specific services | hotel inventory/rates/bookings; external TBO, STAAH, AxisRooms, ResAvenue, Hobse |

## Route-precedence evidence

`ItinerariesController` places `@Get(':id')` at the end and uses `ParseIntPipe` for the generic ID route. Static routes requiring protection include `/details/:quoteId`, `/latest`, `/confirmed`, `/cancelled`, `/customer-info/:planId`, and `/hotel-rooms/categories`. This ordering is captured as a contract risk and must be checked after every controller change.

## Inactive/stale candidates

The workspace contains backup/archived directories (`backups`, `extraa files`, `pre-pr354-worktree`, `refactor-itinerary-worktree`) and prior working snapshots. They are excluded from implementation until an active import is proven. `previous-working-timeline-builder.ts` is retained as historical evidence only.

## Evidence gaps

Exact database rows, endpoint timings, query counts, and external-provider results require a safe non-production fixture or explicitly configured local database. No production request is made by this document capture.
