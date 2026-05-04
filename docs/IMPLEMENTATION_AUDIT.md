# IMPLEMENTATION_AUDIT.md

## Scope
PHASE 1 audit only. No implementation changes made.

## Main Backend Files
- [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts)
- [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts)
- [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts)
- [api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/route-engine.service.ts)
- [api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts](api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts)
- [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts)
- [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts)
- [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.hotspot-selector.ts)

## Main Frontend Files
- [dvi_frontend/src/pages/ItineraryDetails.tsx](dvi_frontend/src/pages/ItineraryDetails.tsx)
- [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts)
- [dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx](dvi_frontend/src/pages/CreateItinerary/CreateItinerary.tsx)
- [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx)
- [dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts](dvi_frontend/src/pages/CreateItinerary/helpers/useItineraryRoutes.ts)
- [dvi_frontend/src/pages/CreateItinerary/helpers/itineraryUtils.ts](dvi_frontend/src/pages/CreateItinerary/helpers/itineraryUtils.ts)

## Main Prisma Models
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_itinerary_plan_details
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_itinerary_route_details
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_itinerary_route_hotspot_details
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_itinerary_route_activity_details
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_itinerary_via_route_details
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_hotspot_place
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_hotspot_timing
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_activity
- [api.dvi.travel/prisma/schema.prisma](api.dvi.travel/prisma/schema.prisma) model dvi_activity_time_slot_details

## What Exists
- Backend has full endpoint coverage for hotspot/activity add, preview, delete, route rebuild, and route time update in [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts).
- Full timeline rebuild pipeline exists: service -> hotspot engine -> timeline builder.
- Deleting a hotspot persists exclusion in route JSON (excluded_hotspot_ids) and triggers rebuild.
- Via-route persistence and reconstruction exists via route payload plus [api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts](api.dvi.travel/src/modules/itineraries/engines/via-routes.engine.ts).
- Frontend ItineraryDetails supports conflict preview UX for activities and preview UX for hotspot insertion.
- Route-level start/end time update path exists and triggers backend rebuild.

## What Is Partial
- Activity insertion behavior is local append + downstream time shift for current route segment, not a full route/day re-optimization pass.
- Timeline prioritization rules are implemented but not clearly aligned to strict business order constraints (priority-first then nearest chain for remaining).
- Direct/via/day-1 and carry-forward behavior is present but spread across large conditional paths in [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.builder.ts), making parity verification hard.
- Frontend rebuild UX after delete-hotspot is explicit, but some paths depend on user action instead of always auto-rebuilding in the same interaction.

## What Is Broken Or High Risk
- Preview hotspot add currently uses a DB create inside preview flow in [api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts](api.dvi.travel/src/modules/itineraries/engines/hotspot-engine.service.ts). The preview path is wrapped in a normal transaction from [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts), with no explicit rollback marker in preview method. This is high risk for preview side effects.
- Frontend API wrapper mismatch: addManualHotspot calls generic hotspots/add endpoint instead of manual-hotspot endpoint in [dvi_frontend/src/services/itinerary.ts](dvi_frontend/src/services/itinerary.ts), while backend exposes dedicated manual-hotspot routes in [api.dvi.travel/src/modules/itineraries/itineraries.controller.ts](api.dvi.travel/src/modules/itineraries/itineraries.controller.ts).
- Activity delete in [api.dvi.travel/src/modules/itineraries/itineraries.service.ts](api.dvi.travel/src/modules/itineraries/itineraries.service.ts) deletes record and updates route timestamp only, without full timeline re-optimization.
- Scoring helper inconsistency in [api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts](api.dvi.travel/src/modules/itineraries/engines/helpers/timeline.scoring.ts): comments indicate one ordering intent, active formula applies different weight order.
- Create itinerary direct toggle logic in [dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx](dvi_frontend/src/pages/CreateItinerary/RouteDetailsBlock.tsx) sets No in both branches, so Yes cannot be restored from UI.

## What Is Missing
- No clear reusable customization template persistence model/flow for storing and reapplying itinerary customization profiles.
- No explicit parity harness asserting PHP-equivalent sequencing for add/delete activity and hotspot operations across multi-day routes.
- No clear guardrail tests around preview isolation (guarantee that preview never persists).

## Recommended Change Order (PHASE 2 input)
1. Fix preview-write safety first (ensure all preview paths are side-effect free).
2. Align frontend manual hotspot API mapping with backend manual-hotspot endpoints.
3. Enforce full re-optimization policy for delete-activity and validate add-activity policy.
4. Normalize scoring/priority semantics and document exact business precedence.
5. Fix direct-visit toggle behavior in create flow and verify payload parity.
6. Add focused regression tests: preview isolation, delete/add activity cascade, multi-day carry-forward, morning/evening defer, direct/via transitions.
7. Design and add reusable customization template persistence only after core behavior parity is stable.

## Notes
- This audit is based on current TypeScript implementation and frontend integrations only.
- No DB migration or source code changes were performed in this phase.
