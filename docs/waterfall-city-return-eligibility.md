# Waterfall city and automatic return eligibility

## Pre-edit root cause and intended outcome

Valara (357) contains airport/station source aliases but lacks Cochin city.
The existing normalizer returns `cochin` for the airport and `kochi` for the city;
therefore its route-chain match really is false for Cochin city. Cheeyappara
(228) already includes both aliases. Add Cochin to Valara's master source aliases
without changing global city normalization, coordinates, timings or priorities.

Both masters describe Cochin to Munnar only. The shared route-chain matcher is
directional, so an automatic Munnar to Cochin route never receives either stop.
Add an explicit master opt-in, `hotspot_allow_reverse_auto_route`, default 0.
Enable it only on these two staging masters. Reverse matching is allowed on a
simple two-endpoint route; explicit via chains keep their existing directional
semantics. A positive match returns indices in the actual route's travel order.
Forward ownership matching remains unchanged.

Expected scheduling is Cheeyappara then Valara outbound and Valara then
Cheeyappara on return when time and road fit permit. Admission is not mandatory:
opening hours, the full priority-destination visit, departure reporting time,
the cumulative 5 km / 15 minute detour budget, exclusions and plan-wide duplicate
prevention must still apply. Previously visited falls must not be repeated.

## Blast radius and invariants

The master flag must reach the builder's master lookup, candidate selection,
bucket normalization, direct-route corridor gate and ownership validation. All
these use the same route policy through TimelineCandidatePolicyService.
The raw master load includes all Prisma fields. Existing hotspot form updates
omit the new field and therefore retain it; creates use the default 0.

No API request/response schema, user-selected via, manual-order protection,
scoped-preservation rebuild, source/destination priority, same-city policy,
November destination preemption, departure editor, hotel billing, pricing or
provider behavior changes. Existing pins and geometry-derived caches stay valid.
The schema migration adds only a default-off metadata column; opt-ins are a
separate backed-up staging data correction.

## Predicted regression matrix

| Scenario | Predicted result |
| --- | --- |
| Cochin city to Munnar, enough time | Both eligible, Cheeyappara then Valara |
| Airport to Munnar | Existing forward order and park priority preserved |
| Automatic Munnar to Cochin city/airport | Eligible falls in Valara then Cheeyappara order |
| Non-opted-in reverse corridor | Still rejected |
| Explicit via chain | Existing forward-only ownership semantics retained |
| Same city, empty or unrelated endpoints | No new corridor match |
| Late arrival or short departure window | Keep priority/departure deadline; do not force falls |
| One fall excluded, closed or visited | Preserve exclusion/hours/no-repeat handling |
| Road failure or excessive detour | Existing guarded fallback; no unverified heavy return |
| Manual / direct / scoped rebuild | Existing ordering and preservation rules retained |
| Repeat / reload | Stable order, no duplicate or overlapping visits |
| DVI20261116 departure fix | 21:00 departure, 19:00 cutoff and feasible Madurai visits retained |

Verify source-policy and candidate-selection tests, forward/reverse road ordering,
existing timeline and departure tests, Prisma/build checks, then Codex browser
rebuilds of city/airport outbound, automatic return, previously visited and tight
deadline cases. Expired quotes remain read-only; use clearly labelled future
test copies of their route chains. Back up masters and affected itinerary state
before applying staging data changes, and restore temporary control edits.
