# Hotspot Timeline Engine - Architecture Guide

## Purpose
This document explains how the NestJS itinerary engine builds hotspot timelines across route days.

It focuses on:
- how hotspots are selected per route
- how Day-2 intercity reservation works before destination loopback days
- how multi-pass scheduling, rejection, retry, and filler insertion work
- why strict dedup is preserved across the plan
- how same-city optimizer work must be verified against the active workspace and live development database

Scope note:
- this guide describes the current runtime architecture and its stable invariants
- hotspot selection, scheduling, and manual insertion rules are intended to stay global across itineraries


## Active Workspace Source Of Truth

All hotspot-timeline debugging and validation must use the currently opened project workspace,
its active backend/frontend source files, and the configured development database.

Do not treat ZIP archives, extracted snapshots, backup folders, or copied source trees as runtime truth
unless import tracing proves the running application actually uses them.

ASCII:

[Active VS Code workspace]
           |
           v
[Real backend source + real frontend source]
           |
           v
[Configured local DB + running API]
           |
           v
[Rebuild itinerary through normal flow]
           |
           v
[Read DB rows + details API + rendered UI]

Required investigation order:
1. inspect active source files
2. inspect current DB rows
3. reproduce through the normal save/rebuild flow
4. verify persisted timeline rows
5. verify details API response
6. verify frontend rendering

Rule:
- do not declare a hotspot-timeline fix complete based only on static code review or archive comparison


## Normal Rebuild Ownership

Same-city cross-day rebalance belongs to the normal itinerary rebuild pipeline.
It is not a special proof-only mode and it must not depend on a quote-specific shortcut.

ASCII:

[Create / Edit / Rebuild request]
              |
              v
[Persist plan + routes + travellers + vehicles]
              |
              v
[Build normal hotspot timeline]
              |
              v
[Apply same-city cross-day optimizer]
              |
              v
[Rebuild affected routes through same timeline engine]
              |
              v
[Persist final travel + visit rows]
              |
              v
[Details API]
              |
              v
[Frontend itinerary page]

Rule:
- if a browser user clicks submit on the normal itinerary flow, the same-city optimizer result must already be reflected in the rebuilt persisted timeline
- no UI-only repair is allowed for missing travel rows, stale times, or adjacency defects


## High-Level Pipeline

ASCII flow:

[Load Plan + Routes + Hotels + Settings]
                  |
                  v
[Preload all hotspots + timings + lookup maps]
                  |
                  v
           [For each route]
                  |
                  v
      [Build selectedHotspots pool]
                  |
                  v
[Apply reservation logic for next loopback day]
                  |
                  v
      [Schedule with route strategy]
      - Day1 different-city strict walk
      - Other days multi-pass loop
                  |
                  v
      [Persist travel + attraction rows]
                  |
                  v
      [Insert breaks/hotel/checkin/end]


## Core Concepts

### 1) Plan-level dedup (global invariant)
A hotspot already inserted anywhere in the same itinerary plan cannot be inserted again.

Invariant:
- addedHotspotIds is global across route loop
- duplicate check is strict (no bypass)

Result:
- no cross-day repeat of same hotspot ID


### 2) Bucketed matching
Candidates are bucketed from hotspot_location against route city context:
- source
- via
- destination

Global matching uses normalized city equivalence, not strict token-only equality.
This allows route city Chennai to match hotspot tokens like Chennai Egmore Station.


### 3) Day-2 reservation before destination loopback
When route N is intercity (A -> B) and route N+1 is loopback at B (B -> B), engine may reserve B hotspots for next day.

ASCII:

Route N:   A --------> B
Route N+1: B --------> B

If next route (N+1) has enough feasible capacity,
then on route N:
- destination bucket hotspots are filtered out
- source fallback hotspots are merged in

This preserves destination inventory for the loopback day.


### 4) Multi-pass scheduler (other days)
For non-Day1-strict branch, candidates are processed in 4 passes.

ASCII:

Pass 1: strict priorities (1..3)
   |
   +-- reject/defer -> queues
   v
Pass 2: deferred strict retries
   |
   +-- reject -> queue
   v
Pass 3: rejected retry queue
   |
   v
Pass 4: filler candidates (priority 0 or >3)

Important:
- pass progression is unconditional across 1..4
- this prevents empty days when strict adds none but filler is available


### 5) Intercity arrival deadline enforcement (critical)
For non-last intercity routes, hotspot scheduling is not allowed to consume the full route window.

Engine computes:
- routeEndSeconds = configured route end (for example 20:00)
- intercityTravelSeconds = sourceCity -> destinationCity travel (outstation type=2)
- latestNonHotelEndSeconds = routeEndSeconds - intercityTravelSeconds

This is only the coarse first estimate.

Actual acceptance rule for non-last intercity routes is candidate-specific:
- compute hotspot visit end
- compute travel from that hotspot to the route destination city
- accept only if projected arrival at destination <= routeEndSeconds

So the engine does not blindly stop sightseeing based on source-city-to-destination travel.
If a later hotspot is already close to the destination city, it can still be accepted.

So low-priority/non-essential hotspots are dropped when needed to preserve enough time to reach hotel/destination by end-of-day.

This specifically prevents invalid display cases like:
- travel row shown as 08:00 PM - 08:00 PM with non-zero duration


## Detailed Route Algorithm

For each route:

1. Resolve route context
- source city, destination city, coords, route start/end window
- day flags (first route, last route, intercity, loopback)
- compute latestNonHotelEndSeconds for non-last intercity routes using source->destination travel estimate

2. Build selectedHotspots
- fetchSelectedHotspotsForRoute() using source/via/destination buckets
- merge manual selections (manual entries pinned and preserved)

3. Destination reservation feasibility check
- if route is intercity and next route is destination loopback candidate:
  - fetch next route candidates
  - count available non-duplicate hotspots
  - estimate next-route capacity from route window
  - compute minimumRequired = min(staticCap, estimatedCapacity), floor 1
  - reserve only if available >= minimumRequired

4. If reservation active
- drop destination bucket from current route candidate pool
- enforce dedup pre-filter
- fetch source fallback (non-duplicate, city-normalized matching)
- merge source fallback first

5. Scheduling branch
- Day1 different-city route:
  - strict ordered walk with operating-hour checks
- Other routes:
  - run multi-pass 1..4
  - apply cutoff and operating-hour rules
  - for non-last intercity routes, apply candidate-specific projected-arrival check
    instead of only using a fixed route-wide end cutoff
  - for last route, keep enough time for return to departure/airport
  - queue deferred/rejected hotspots for later passes

6. Persist rows
- add travel row (item_type travel)
- add attraction row (item_type attraction)
- update currentTime/currentLocation/currentCoords

7. End-of-route composition
- insert break rows when needed
- trailing free-time gap for non-last routes is capped at latestNonHotelEndSeconds
  (not full routeEndSeconds), so hotel transfer starts at the correct departure window
- add destination transfer/hotel/checkin rules


## Same-City Cross-Day Rebalance And Travel-Leg Integrity

This section documents the newer timeline rules clarified during July 2026 debugging.

### 0) Latest July 2026 scheduling rules

These are the newest timeline rules verified in the active workspace during the
`DVI20260798` debugging cycle.

Rules:
- feasible `priority 0` auto hotspots are distance-led before generic filler score fallback
- `priority 0` auto hotspots must not consume a wait-to-open gap just to catch a later shift
- manual and stronger-priority hotspots may still use a later opening window when the route can support it
- split operating windows on the same day must be treated as separate valid visit windows, not collapsed into a single misleading row
- scenario/debug explanations should describe timing per selected slot, not only as a day-level summary

ASCII:

[candidate reaches hotspot]
          |
          v
[check active operating window now]
          |
     +----+----+
     |         |
    yes        no
     |         |
     v         v
[can fit]   [next window exists?]
               |
          +----+----+
          |         |
         no        yes
          |         |
          v         v
    [reject now]  [priority > 0 or manual?]
                    |
               +----+----+
               |         |
              no        yes
               |         |
               v         v
   [reject: no wait for   [allow wait if route still fits]
    optional auto stop]

### 1) Rebalance is part of normal rebuild

Same-city cross-day hotspot rebalancing is not a special UI-only mode.
It belongs to normal timeline generation for:
- create flows
- update/edit flows
- standard rebuilds triggered by `type=itineary_basic_info`
- route-optimized rebuilds, as long as they still rebuild the timeline

ASCII:

[Save / Update request]
          |
          v
[Plan + Route rows persisted]
          |
          v
[Timeline rebuild starts]
          |
          v
[Same-city chain detected?]
    |                 |
   no                 yes
    |                 |
    v                 v
[normal build]   [rebalance movable auto hotspots]
                        |
                        v
              [persist final travel + visit rows]

Rule:
- no special request flag should be required just to enable this behavior for the normal edit/save path


### 2) Fixed anchors stay pinned

The optimizer may move movable auto hotspots between consecutive same-city days,
but it must not freely reshuffle everything.

Pinned first:
- manual hotspots
- fixed anchors
- protected priority hotspots
- transfer-only terminal protection

Movable after that:
- optional / filler auto hotspots
- non-anchor auto hotspots that fit a same-city rebalance

ASCII:

[Day hotspot pool]
      |
      v
[Split into pinned vs movable]
      |
      +--> pinned
      |    - manual
      |    - fixed anchor
      |    - protected priority hotspot
      |    - transfer-only terminal protection
      |
      v
[Only movable set is eligible for cross-day shift]


### 3) Near-neighbor hotspots should stay adjacent when moved

When two movable hotspots are effectively neighbors in the same city,
the preferred outcome is to keep them on the same rebuilt day and beside each other.

July 2026 example:
- `Charminar`
- `Macca Masjid`

ASCII:

[Day 1]               [Day 2]
  Macca                Charminar
    |                      |
    +------ same-city -----+
            near-neighbor
                 |
                 v
     [rebalance to target day together]
                 |
                 v
[Day 2 rebuilt order]
  ... -> Charminar -> Macca Masjid -> ...

Rule:
- unrelated fillers should not be inserted between a near-neighbor pair if the rebalance logic is explicitly trying to keep them together

Verified live result for `DVI20260798` after the current rebuild fix:
- `Macca Masjid` moves off Day 1 and onto Day 2
- `Macca Masjid` keeps its inbound travel row
- the current verified Day 2 order is `Macca Masjid -> Charminar`
- this is still considered valid adjacency because the pair remains consecutive with a short local hop
- the earlier broken overlap and orphan-visit state is no longer present


### 3A) Feasible priority-0 fillers are now distance-led

For optional auto hotspots, the preferred winner is the nearest feasible candidate
for the slot being filled.

This is not "nearest no matter what".
It means:
- same priority bucket
- timing actually matches
- route-end checks still pass
- then nearest candidate should win before generic filler-score fallback

ASCII:

[priority 0 candidates for slot]
            |
            v
[remove candidates that do not fit timing]
            |
            v
[remove candidates that break route-end / transfer checks]
            |
            v
[sort by nearest feasible distance]
            |
            v
[only then use generic filler score / stable tie-break]


### 3B) Optional auto hotspots must not wait for a later shift

If a `priority 0` auto hotspot arrives before its next valid opening window,
the engine should reject it instead of creating a long dead waiting block.

Example of the rule:
- `Birla Mandir` has split timing windows:
  - `07:00 AM -> 12:00 PM`
  - `02:00 PM -> 08:00 PM`
- if an optional auto candidate reaches it at `12:35 PM`,
  the engine should not hold the timeline idle until `02:00 PM`
- that hotspot should lose to another feasible `priority 0` option that can be visited without waiting

ASCII:

[optional auto hotspot arrives 12:35 PM]
                 |
                 v
[next open shift starts 02:00 PM]
                 |
                 v
[waiting required = 1h 25m]
                 |
                 v
[reject optional auto hotspot]

But:
- manual hotspots can still be allowed to wait
- stronger-priority hotspots can still be allowed to wait if the route remains valid


### 3C) Split shifts must be treated as separate windows

Some hotspots have more than one timing row for the same day.
The engine and the scenario/debug layer must both treat them as multiple usable windows.

Correct representation example:
- `Birla Mandir`
  - `07:00 AM -> 12:00 PM`
  - `02:00 PM -> 08:00 PM`

Incorrect representation:
- only showing the first row and pretending the hotspot is closed for the afternoon

ASCII:

[same-day timing rows]
     |
     +--> 07:00 - 12:00
     |
     +--> 02:00 - 08:00
     |
     v
[visit may fit either valid window]

Rule:
- a candidate is valid if its full visit fits inside any one same-day operating window
- scenario/debug output should print all same-day windows, joined in order


### 4) No persisted visit row should lose its inbound travel leg

A sightseeing row is not valid on its own.
If `item_type = 4` exists after rebuild, the matching inbound `item_type = 3` must also exist.

ASCII:

[travel row item_type=3]
          |
          v
[visit row item_type=4]

Valid persisted pair:
  3 -> 4

Invalid persisted shape:
  4 only

This rule still applies after:
- same-day reorder
- manual insertion
- same-city cross-day movement
- final persistence repair

Practical meaning:
- no hotspot card in the details UI should appear as an orphaned visit because rebuild dropped or forgot the inbound travel row

Verified live result for `DVI20260798`:
- Day 2 now persists `Hotel -> Macca Masjid -> Charminar`
- `Macca Masjid` has an inbound travel row `09:00 AM -> 09:30 AM`
- `Macca Masjid` visit is `09:30 AM -> 09:50 AM`
- `Macca Masjid -> Charminar` travel is `09:50 AM -> 09:55 AM`
- `Charminar` visit is `09:55 AM -> 10:55 AM`
- therefore the rebuilt timeline has both adjacency and travel-leg integrity for this pair


## Manual Hotspot Preview/Apply Flow

Manual hotspot insertion does not bypass the engine.

Runtime behavior is:

1. User selects one or more hotspots in the add-hotspot modal
- selection is treated as manual/protected input
- persisted manual rows use hotspot_plan_own_way = 1

2. Backend runs adaptive insertion preview
- try to place the selected manual hotspot(s) into the rebuilt route timeline
- preserve manual rows ahead of normal automated trimming
- remove non-priority fillers first when space must be created

3. Priority replacement is gated
- if optional/non-priority hotspots are enough, they are removed first
- if protected top-priority hotspots would need to be replaced, backend marks preview as requiring confirmation
- frontend must not auto-apply that case

4. Rebuilt preview is revalidated
- preview is checked again against actual route constraints after insertion/removal attempt
- validation covers schedule fit, overlap, operating windows, and route-end overflow
- response now carries explicit validation state such as:
  - passesScheduleRules
  - readyToApply
  - requiresPriorityConfirmation
  - stillUnschedulable
  - reason

5. Apply is allowed only when rebuilt preview is valid
- frontend blocks final add when readyToApply is false
- unresolved conflicts are not treated as informational only
- this ensures manual hotspots still obey the same timing/distance/slot rules as normal engine output

Shared solver contract:

- Fit Here and Auto Preview use the same backend rescue/removal engine.
- The only difference is how anchors are enumerated:
  - Fit Here evaluates the single clicked anchor gap.
  - Auto Preview evaluates every valid anchor on the route and ranks the results using the same solver.
- Do not maintain a separate rule set for the two modes.
- If a hotspot has multiple same-day operating windows, keep the windows separate and let the solver wait for the next valid window when the route still fits.
- That wait behavior is allowed for manual or stronger-priority hotspots; priority 0 auto hotspots should not wait across a long closed gap just to catch a later shift.

Example:

- if a hotspot is closed at `1:36 PM` but re-opens at `4:00 PM`, manual Fit Here may wait for the later window instead of failing early, provided the route still fits after the wait


## Travel Distance Source Of Truth

Travel rows are not all resolved the same way.

1. Hotspot-to-hotspot travel
- prefers coordinates when both source and destination coordinates are known
- uses Haversine-based calculation via DistanceHelper.fromCoordinates()

2. City-to-city travel
- prefers dvi_stored_locations exact match
- falls back to coordinates when possible

2A. Short local hotspot-to-hotspot movement
- when both hotspot coordinates are known, helper should use coordinate distance
- current local rule uses Haversine base distance with a `1.5x` correction factor
- current local rule does not add the old common road buffer
- very short local hops clamp to a minimum travel time of `00:05:00`

ASCII:

[source hotspot coords] + [dest hotspot coords]
                  |
                  v
      [DistanceHelper.fromCoordinates()]
                  |
                  v
    [raw haversine km * 1.5 correction]
                  |
                  v
    [min local travel time = 5 minutes]

Example:
- `Charminar -> Macca Masjid`
- raw straight-line distance is only about `0.053 km`
- current helper result is about `0.079 km` after the `1.5x` correction
- this pair should therefore behave like a near-adjacent local hop, not like a generic city transfer

3. Last-route return to departure/airport
- must pass BOTH sourceCoords and destCoords when building item_type = 7
- if sourceCoords are omitted, helper can fall back to a stored-location row with distance 0
  while still showing a minimum travel time

That is the exact root cause of the earlier broken row:
- Guindy National Park -> Chennai International Airport
- time shown, but distance = 0.00 KM

Fix applied:
- return-row builder now receives sourceCoords as well as destCoords
- final airport leg now resolves to a real distance (for example 12.25 KM)


## Rejection + Retry Model

Rejection sources include:
- duplicate hotspot in plan
- source/via/destination cutoff time breaches
- exceeds effective route feasibility window
  - non-last route: projected arrival at destination after this hotspot > routeEndSeconds
  - last route: projected arrival at departure terminal > lastRouteArrivalDeadlineSeconds
- outside operating hours
- closed for day

Queues:
- deferredPriorityHotspots (must-visit strict deferrals)
- rejectedRetryHotspots (retry set for hard/soft rejects)
- sourceCutoffRejectedHotspotIds (source cutoff-specific retry bypass in pass 3)

This gives controlled looping without duplicate insertion.


## Data Structures Used (Exact Runtime Shapes)

This section lists the major arrays, sets, and maps used by the current engine.

### Plan-scope (lives across all routes in the same build)

1. addedHotspotIds: Set<number>
- Meaning: global dedup index for the plan
- Written: every time attraction is successfully inserted
- Read: before every candidate scheduling attempt
- Scope: entire plan (all routes)

2. allHotspots: Hotspot[]
- Meaning: preloaded active hotspot master rows
- Built once at plan start
- Reused by all routes

3. timingMap: Map<number, Map<number, TimingRow[]>>
- Meaning:
  - key1 = hotspotId
  - key2 = dayOfWeek (PHP style 0..6)
  - value = timing rows for that hotspot/day
- Built once at plan start
- Read in operating-hour checks during scheduling

4. hotspotMap: Map<number, HotspotLite>
- Meaning: O(1) hotspot metadata lookup (location/coords/duration)
- Built once at plan start


### Route-scope (rebuilt for each route)

1. selectedHotspots: SelectedHotspot[]
- Candidate pool after bucket matching + manual merge + reservation filters

2. sourceLocationHotspots: Hotspot[]
3. viaRouteHotspots: Hotspot[]
4. destinationHotspots: Hotspot[]
- Temporary bucket arrays created during fetchSelectedHotspotsForRoute

5. strictHotspots: SelectedHotspot[]
- Priorities 1..3

6. fillerHotspots: SelectedHotspot[]
- Priority 0 or >3

7. deferredPriorityHotspots: SelectedHotspot[]
8. deferredPriorityHotspotIds: Set<number>
- Queue + membership set for deferred strict candidates

9. rejectedRetryHotspots: SelectedHotspot[]
10. rejectedRetryHotspotIds: Set<number>
- Queue + membership set for rejected-retry candidates

11. sourceCutoffRejectedHotspotIds: Set<number>
- Tracks source-cutoff rejects so pass 3 can bypass that specific gate

12. uniqueNextRouteIds: Set<number>
- Used in destination reservation feasibility counting (de-dup next route candidates)

13. selectedById: Map<number, SelectedHotspot>
- Used during manual merge and fallback merge to avoid duplicate IDs in candidate list


### Why arrays + sets are paired

ASCII:

[Queue Array] -----------------> preserves processing order
     |
     v
[Membership Set] -------------> O(1) duplicate-prevention for enqueue

This prevents quadratic enqueue checks when retries accumulate.


## How Many Times Queues/Arrays Are Checked

The scheduler is bounded by 4 passes per route.

ASCII pass loop:

for pass in [1,2,3,4]:
  candidates = passArray(pass)
  for each candidate in candidates:
    run gating checks


### Check-frequency matrix per route

1. selectedHotspots
- Built once
- Partitioned once into strictHotspots + fillerHotspots
- Iterated once during partition

2. strictHotspots
- Iterated in pass 1 exactly once

3. deferredPriorityHotspots
- Enqueue attempts happen in pass 1 when deferred conditions hit
- Iterated in pass 2 exactly once
- No additional enqueue in pass 2 for same ID because deferredPriorityHotspotIds blocks duplicates

4. rejectedRetryHotspots
- Enqueue attempts happen mainly in pass 1 (cutoff / outside window / large wait cases)
- Iterated in pass 3 exactly once
- Duplicate enqueue blocked by rejectedRetryHotspotIds

5. fillerHotspots
- Iterated in pass 4 exactly once

6. addedHotspotIds.has(hotspotId)
- Checked once per candidate attempt in each pass where candidate appears
- Worst case per hotspot: up to 4 checks if candidate can appear across retry paths

7. queueRejectedHotspotForRetry(...)
- Called only from reject branches, mostly pass 1
- Effective insertion max once per hotspot ID (set-guarded)

8. queueDeferredMustVisitHotspot(...)
- Called from defer/reject branches
- Effective insertion max once per hotspot ID (set-guarded)


### Upper bound (practical)

Let N = size(selectedHotspots) for a route.

- Partition cost: O(N)
- Pass iterations: O(S + D + R + F)
  where:
  - S = strictHotspots count
  - D = deferredPriorityHotspots count
  - R = rejectedRetryHotspots count
  - F = fillerHotspots count

Because all queue sets block duplicate IDs, each hotspot ID is typically processed in a small bounded number of passes.

Practical bound per hotspot ID:
- strict path: pass1 only
- deferred path: pass1 then pass2
- rejected retry path: pass1 then pass3
- filler path: pass4

So real-world attempts per hotspot are usually 1 to 3, not unbounded looping.


## Candidate Lifecycle (ASCII State Machine)

This shows exactly where queue checks happen.

ASCII:

[Candidate from selectedHotspots]
          |
          v
  [Duplicate check: addedHotspotIds]
          |
      no duplicate
          v
 [Cutoff/Window/Route-end checks]
    |          |           |
    |          |           +--> queueDeferred (set guarded)
    |          +---------------> queueRejected (set guarded)
    +--------------------------> proceed
                               |
                               v
                     [Persist travel+attraction]
                               |
                               v
                      [addedHotspotIds.add(id)]


## Reservation Data Flow (with structures)

ASCII:

[nextRouteCandidates[]]
      |
      v
[uniqueNextRouteIds Set] -> count non-duplicate -> nextLoopbackAvailableCount
      |
      v
[estimateRouteHotspotCapacity(nextRoute)] -> nextLoopbackMinimumRequired
      |
      v
if available >= minimumRequired:
  selectedHotspots = remove(destination bucket)
  selectedHotspots = remove(ids in addedHotspotIds)
  sourceFallback = fetchDay1TopPrioritySourceHotspots(...)
  selectedById Map merge -> final selectedHotspots


## Pseudocode (with queue check counts)

```text
for route in routes:
  selected = buildCandidatePool(route)
  strict, filler = partition(selected)
  deferred = [] ; deferredIds = Set()
  rejected = [] ; rejectedIds = Set()

  for pass in [1,2,3,4]:
    candidates = choose(pass, strict, deferred, rejected, filler)

    for hs in candidates:
      # checked every attempt
      if hs.id in addedHotspotIds: continue

      # reject/defer checks (can enqueue once each due to sets)
      if cutoffRejected(hs):
        if hs.id not in rejectedIds: rejected.push(hs); rejectedIds.add(hs.id)
        continue

      if windowRejected(hs):
        if hs.id not in deferredIds: deferred.push(hs); deferredIds.add(hs.id)
        continue

      if routeEndRejected(hs):
        if hs.id not in deferredIds: deferred.push(hs); deferredIds.add(hs.id)
        continue

      persist(hs)
      addedHotspotIds.add(hs.id)
```


      ## Concrete Numeric Example (Operation Counts)

      This section gives an explicit count example for one route so reviewers can reason about cost and behavior.

      Assume for one route:
      - selectedHotspots N = 18
      - strictHotspots S = 6 (priority 1..3)
      - fillerHotspots F = 12
      - Of strict 6:
        - 2 inserted in pass 1
        - 2 deferred to pass 2 (large wait / route-end)
        - 2 rejected to pass 3 (cutoff/window)
      - Pass 2 inserts 1 of deferred; 1 remains rejected
      - Pass 3 inserts 1 from rejected
      - Pass 4 inserts 4 fillers (rest fail by time window)

      ### Pass-by-pass counts

      Pass 1 (strict 6):
      - candidate iterations: 6
      - addedHotspotIds.has checks: 6
      - queueDeferred attempts: 2
      - queueRejected attempts: 2
      - insertions: 2

      Pass 2 (deferred 2):
      - candidate iterations: 2
      - addedHotspotIds.has checks: 2
      - additional queue attempts: up to 1 (if still not feasible)
      - insertions: 1

      Pass 3 (rejected 2):
      - candidate iterations: 2
      - addedHotspotIds.has checks: 2
      - additional queue attempts: usually 0 (same IDs set-guarded)
      - insertions: 1

      Pass 4 (filler 12):
      - candidate iterations: 12
      - addedHotspotIds.has checks: 12
      - queue attempts: usually 0..small (depends on branch)
      - insertions: 4


      ### Totals for this route

      1. Candidate loop iterations
      - 6 + 2 + 2 + 12 = 22 iterations

      2. Global dedup set lookups
      - addedHotspotIds.has = 22

      3. Queue insertion attempts
      - deferred attempts = 2 (pass1) + up to 1 (pass2) = 3 max attempts
      - rejected attempts = 2 (pass1) + up to 1 (pass2/3 edge) = 3 max attempts

      4. Effective queue insertions (after set guards)
      - deferredPriorityHotspots actual unique inserts <= 2
      - rejectedRetryHotspots actual unique inserts <= 2

      5. Successful attraction insertions
      - 2 + 1 + 1 + 4 = 8 attractions


      ### Why attempts and inserts differ

      ASCII:

      [queue call attempt]
        |
        v
      [Set has(id)?] -- yes --> [skip enqueue]
        |
            no
        v
      [enqueue + add id to set]

      So queue call count can be higher than actual queue growth.


      ### Reservation check example count

      Assume nextRouteCandidates length = 9.

      Reservation feasibility loop does:
      - up to 9 uniqueNextRouteIds.has checks
      - up to 9 addedHotspotIds.has checks
      - 1 capacity estimate call
      - 1 threshold comparison

      If available count >= minRequired:
      - one filter over selectedHotspots (remove destination)
      - one filter over selectedHotspots (remove already added)
      - one source fallback fetch
      - one merge/dedup pass via selectedById map


      ### Complexity view from this example

      - Route scheduling is linear in number of candidates seen across passes.
      - Set guards keep retries bounded per hotspot ID.
      - No unbounded while-retry behavior exists in normal flow.


## Pseudocode (Current Logic)

```text
buildTimeline(plan, routes):
  preload allHotspots
  preload allTimings
  addedHotspotIds = Set()

  for route in routes:
    ctx = resolveRouteContext(route, plan)

    selected = fetchSelectedHotspotsForRoute(ctx, allHotspots)
    selected = mergeManualSelections(selected, route)

    if isIntercityBeforeLoopback(route, nextRoute):
      nextCandidates = fetchSelectedHotspotsForRoute(nextRoute, allHotspots)
      available = countNonDuplicate(nextCandidates, addedHotspotIds)
      cap = estimateRouteHotspotCapacity(nextRoute)
      minRequired = max(1, min(STATIC_MIN_RESERVE, cap))

      if available >= minRequired:
        selected = removeDestinationBucket(selected)
        selected = removeAlreadyAdded(selected, addedHotspotIds)
        fallback = fetchDay1TopPrioritySourceHotspots(
          route,
          excluded=addedHotspotIds,
          includeZeroPriority=true,
          maxResults=adaptiveByRouteCapacity(route)
        )
        selected = mergeFallbackFirst(selected, fallback)

    if isDay1DifferentCities(route):
      scheduleDay1Strict(selected)
    else:
      strict = filterPriority1to3(selected)
      filler = others(selected)
      deferred = []
      rejected = []

      for pass in [1,2,3,4]:
        candidates = pickPassCandidates(pass, strict, deferred, rejected, filler)

        for hs in candidates:
          if hs.id in addedHotspotIds: continue
          if violatesCutoff(hs, route, pass): queueRetry(...); continue
          if outsideOperatingWindow(hs, route): queueDeferredOrRetry(...); continue

          if nonLastIntercityRoute(route):
            projectedArrival = hotspotVisitEnd + travel(hs -> routeDestination)
            if projectedArrival > routeEndSeconds: queueDeferred(...); continue

          if lastRoute(route):
            projectedArrivalAtDeparture = hotspotVisitEnd + travel(hs -> plan.departure_location)
            if projectedArrivalAtDeparture > lastRouteArrivalDeadlineSeconds: queueDeferred(...); continue

          persistTravelAndAttraction(hs)
          addedHotspotIds.add(hs.id)

        # trailing free-time fill should not consume hotel transfer runway
        trailingGapEnd = isLastRoute ? routeEndSeconds : latestNonHotelEndSeconds
        insertTrailingFreeTimeGapIfNeeded(upTo=trailingGapEnd)

    finalizeRouteRows(route)
```


  ## Response Assembly Rule (Important)

  The persisted DB rows are not stored in pure presentation order.

  Why:
  - hotspot_order is a persistence/grouping key
  - item_type = 3 travel rows are often stored after their corresponding attraction rows
  - item_type = 5/6/7 rows can share hotspot_order with other rows

  So the details API must build response segments in chronological order using:
  - hotspot_start_time
  - hotspot_end_time

  It must NOT rely on hotspot_order alone for rendering.

  Otherwise a cleanup pass like normalizeSegmentChronology() can shift already-correct rows forward,
  which creates fake overruns in the response.

  Exact bug this caused before fix:
  - DB row was correct: Guindy -> airport = 05:42 PM - 06:00 PM
  - response was wrong: 05:48 PM - 06:06 PM

  Fix applied:
  - itinerary-details.service.ts now sorts routeHotspots by actual start/end time before segment assembly
  - normalizeSegmentChronology() now preserves the correct stored chronology instead of distorting it


## Global Safeguards

1. Baseline logic should stay generic
- algorithm is intended to apply to all itineraries/routes
- route selection, scheduling gates, and manual hotspot validation should be controlled by shared engine rules

2. Deterministic ordering
- sort by priority first, then distance, then stable tie-break

3. Manual hotspot protection
- manual selections are preserved and not trimmed by normal automated filters
- when a manual insert cannot fit directly, engine attempts adaptive removal/rebuild before failing
- protected priority replacement requires explicit confirmation plus rebuilt-preview validation

4. Capacity-aware reservation
- destination preservation uses route-time capacity, not a static count alone


## Why this is understandable and maintainable

- clear route-level phases
- explicit queues for defer/retry semantics
- strict dedup invariant prevents regressions
- city matching normalization reduces data-shape brittleness
- pass-based architecture isolates policy changes safely


## Suggested Future Enhancements

1. Add structured debug telemetry per route
- selected_count_by_bucket
- rejected_count_by_reason
- pass_insert_count

2. Add unit tests for:
- city token normalization matches
- intercity-before-loopback reservation gate
- multi-pass progression (pass 4 reached even when pass 1 inserts none)
- manual hotspot preview validation and priority-replacement confirmation gating

3. Add integration snapshots for key route topologies:
- A->B, B->B
- A->A single-city loopback
- last-route terminal transfer constraints

4. Keep diagnostics isolated from scheduling policy
- use explicit debug flags for temporary tracing
- do not couple route selection or timing rules to individual itineraries or proof cases
