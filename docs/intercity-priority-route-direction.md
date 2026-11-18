# Intercity priority destination approach

## Requirement and root cause

Automatically selected corridor stops should be visited on the approach when their
visits fit without sacrificing the priority destination's operating window. Small
detours are allowed. An earlier corridor must not be appended after destination
sightseeing when doing so creates a large return journey.

May 27 commit 0cccead0 introduced route-specific ordering. June 2 commit 9ccea03f
added corridor/filler gates. November 1 commit bcaebd6d preserved destination
operating windows by allowing a priority-1 destination to preempt source visits.
That queue exception had no road-fit check; later passes could append the corridor.
Live rebuilding confirmed that DVI20261115 actually uses the separate Day-1
different-city priority walk. The candidate reordering before that branch can
also place destination priorities 1-3 before corridor priorities 15-16. The fix
therefore shares preparation and corridor admission across both scheduling paths;
the November exception alone is not the cause of this Day-1 case.
DVI20261115 has correctly tagged Cochin-to-Munnar waterfall records. A later
road-access audit also found inaccurate pins for both waterfalls. Staging was
corrected to Cheeyappara 10.0538528,76.8294126 and Valara viewpoint
10.0474918,76.8402585. These data corrections complement the scheduling fix.

## Scope and invariants

The policy applies to automatic non-direct intercity scheduling without explicit
vias, manual selections, or a scoped preservation rebuild. Explicit automatic
route resets participate. Existing direct-route, explicit
via, manual order, deletion preservation, hotel billing, transport arrival and
departure deadline rules retain their existing handling. It does not change API
contracts, database schema, hotspot priorities, coordinates, or billing algorithms.
Same-city touring and legitimate excursions/return-to-hotel journeys are outside
the corridor return restriction.

## Behavior

The November queue logic remains in place. Before materialization, bounded
directional road lookups identify strict/corridor candidates along each destination
approach. Candidates are tried in approach distance order, only if their visit and
the target's full visit remain feasible through the existing admission service.
Projection uses at least the road travel time when that exceeds the normal travel
estimate. Opening windows, waiting, route end and departure deadline still apply.
This projection does not replace the existing timeline distance/rendering provider.
For the Day-1 different-city path, projection consults the same candidate gate as
actual admission. A suppressed terminal-source visit remains in the queue for
normal rejection reporting, but cannot consume projected time or move the cursor.
This matters on repeated builds whose candidate order already starts at a waterfall.
An automatic corridor prefix saved by an earlier build is also reconsidered
against the first priority destination window. It is inserted again only when
feasible; a later arrival must not lose its priority visit merely because the
earlier saved sequence started at a waterfall. Legitimate source prefixes remain
subject to their original scheduling rules.

After a destination attraction is actually scheduled, a source/corridor return
needs positive road-fit evidence and a shared return budget. Rejected ids are
remembered across scheduler passes and excluded from strict repair/carry-forward.
They are logged as AUTO_ROUTE_BACKTRACK_REJECTED, not counted as visited.
Approach decisions are logged as PRIORITY_DESTINATION_ROAD_APPROACH.

Defaults: 5 km extra road travel, 15 minutes extra driving, and a 25% distance
ratio. Short legs use a 20 km denominator floor for the ratio; absolute limits
still apply. Approach insertions share an approach budget; subsequent returns
share a separate return budget. Limits can be configured with
HOTSPOT_ROUTE_MAX_DETOUR_KM, HOTSPOT_ROUTE_MAX_DETOUR_MINUTES, and
HOTSPOT_ROUTE_MAX_DETOUR_RATIO. Set HOTSPOT_ROUTE_DIRECTION=false to disable
the policy for rollback without reverting the November commit.

Road requests use OSRM_BASE_URL (the existing OSRM route endpoint convention), a
2.5 second request timeout, an 8 second per-route lookup deadline, up to 24 requests per route, a bounded 512-entry process cache
and 10 minute cache lifetime. A provider failure stops further uncached calls on
that route. Missing road data preserves priority ordering and does not authorize
an unverified return to an earlier corridor. No straight-line estimate is treated
as proof of acceptable road detour. This is bounded approach planning, not a global
tour optimizer or a guarantee that every selected hotspot can fit.

## Pre-edit regression matrix and predictions

| Scenario | Predicted result |
| --- | --- |
| DVI20261115 early Cochin-Munnar | Feasible waterfalls before Munnar attractions |
| Late arrival / tight park window | Preserve priority visit, reject excessive corridor return |
| Minor return | Allow within cumulative road distance/time budget |
| Existing valid destination-first case | Keep priority target and full operating-window checks |
| Empty / single candidate | Valid output, no unnecessary mutation |
| Multiple candidates | Deterministic approach order and preserved identities |
| Invalid coordinates / provider failure | No crash; priority retained, unverified return not admitted |
| Manual selection / scoped delete rebuild | Existing protection and order preserved |
| Same-city / direct / explicit via | Existing rules preserved |
| Retry / deferred / repair | Excessive rejected return cannot reappear |
| Persistence / repeated build / reload | Stable saved order, unique visits |
| Hotel / transport / integrations | Existing contracts and billing rules preserved |

Validation includes policy tests, the original November tests, shared timeline
tests, TypeScript build, and browser rebuilding/reloading representative staging
itineraries. A baseline snapshot is retained before staging mutations.
