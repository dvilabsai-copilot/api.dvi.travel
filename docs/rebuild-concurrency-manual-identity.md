# Manual identity and concurrent rebuild correction

## Pre-edit analysis (19 November 2026)

MMTLX2026104 plan 11713 fails on Ooty route 23111, hotspot 335.
It is an active saved manual selection. Candidate selection correctly assigns
`isManualSelection`, bypassing the automatic limit of 18. The normal visit-row
builder call omits manual identity, so the final validator sees the master's
priority 26 on an automatic row and throws. The engine restores manual flags
only after that validation, too late. Keep the validator and automatic priority
limits; propagate selection identity when materializing visit rows instead.
The segment builder already supports explicit manual flags; preserve that API.

The staging InnoDB deadlock report from 18:17:50 UTC shows transactions for
different plans holding next-key locks on the parking plan-ID index and each
waiting for insert intention in the same range. Range deletes, including empty
plan ranges in test copies, precede inserts under repeatable read. Select the
existing row primary keys and delete only those unique keys; an empty set must
perform no delete. Apply to timeline, parking and manual-placeholder cleanup.
Keep transaction isolation unchanged. Lock the itinerary parent row before
timing reads/writes and at shared engine/parking entry points to serialize the
same plan. Retry only P2034 transaction conflicts, at most three attempts with
bounded jitter; restart the whole transaction. Pricing/provider callbacks run
only after the successful commit and are never replayed by the retry helper.
Use a separate TimelineBuilder per rebuild because its rejection diagnostics
are mutable and must not leak between concurrent plans.

## Callers and impact

Route timing is called through ItinerariesService/controller. The shared engine
also serves route reset, manual fit, deletion, plan persistence, activities and
cross-day optimization. Its transaction remains owned by each caller; no nested
transaction or hidden commit is introduced. The new transaction helper is used
only by route timing and standalone parking rebuild. Other engine callers get
the narrower deletes and parent lock, with their existing failure contracts.
Hotspot segment consumers retain their existing explicit flag behavior;
selection metadata is optional and defaults to automatic. Strict-slot visits
derive the matching candidate; deferred automatic rescue remains automatic.

## Intended outcome and predicted matrix

| Scenario | Predicted result |
| --- | --- |
| Blocked MMTLX rebuild | Saved manual Tea Museum and manual falls survive; no false automatic violation |
| Truly automatic out-of-range Ooty visit | Still rejected |
| Single manual / automatic / empty selections | Identity preserved; no new admission rule |
| Different plan rebuilds concurrently | No parking gap-range delete lock cycle; all commits finish |
| Same plan edits concurrently | Parent-row lock serializes timeline writes |
| Transient P2034 | Whole rolled-back transaction retries; pricing once after commit |
| Invalid input / policy error / exhausted retries | Existing error propagates; no pricing |
| Empty parking/timeline set | No range delete; insertion still permitted |
| Scoped / tombstone / manual-placeholder cleanup | Original row scope preserved exactly |
| Waterfall outbound / return | Same order, alias, opt-in and detour rules |
| November destination priority | Full Eravikulam reservation remains |
| DVI20261116 departure edit | Actual departure/buffered cutoff and four Madurai visits retained |
| Repeated rebuild / reload | Stable visits, no duplicates, times and selections persisted |

Verify focused identity/policy/transaction tests and build, then browser rebuilds
of the blocked itinerary and concurrent future route copies. Audit headers,
route settings, hotels, exclusions, manual identities, duplicates and overlaps;
restore temporary timing edits. Production is outside this deployment scope.

## Additional failure exposed after manual validation passed

The first staging retest passed Ooty priority validation, then rolled back at
the later terminal-pair validator. A rollback-only inspection captured route
23110: saved manual visits finish at 15:47, but its old airport-to-hotel leg
still spans 11:00–18:21. Manual injection rebuilt attraction legs without
rebuilding the now-stale final hotel leg from the last attraction.

Correct this in manual travel-chain reconciliation: when a manual route has
exactly one terminal journey and one final arrival marker, the journey overlaps
the last visit, and the marker is at/after that visit, rebuild that journey from
the actual last hotspot to the existing selected hotel/destination using the
shared travel builder. Update the marker to the new arrival. Leave the final
validator active. Hotel-first arrivals before sightseeing, already valid final
journeys, automatic-only routes and ambiguous multiple terminal rows must remain
unchanged. Do not reuse the old source-to-hotel distance or shift it blindly.

The post-rebuild audit also exposed a default-order bug: the engine copied each
saved manual position into one route-wide override, so the last saved position
overwrote all other manual positions on that route. Only explicit anchor or
preferred-placement options should create that override; ordinary full rebuilds
must let the placement service use each saved row's order. Verify the original
manual selections and open-stop order on all seven MMTLX days, not just the
requested return day. The rollback replay additionally confirmed Wax Museum
(671) is marked closed on all seven days in the master. The existing deferred /
forced-manual preservation path retains this saved selection at the end; keep
that existing closed-stop behavior and report its order change separately from
lost manual selections. Do not reopen the master or relax automatic admission.
