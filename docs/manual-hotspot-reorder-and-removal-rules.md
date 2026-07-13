# Manual Hotspot Reorder And Removal Rules

## Core principle

Manual Fit Here is not a generic best-fit insertion.

The selected manual hotspot is the primary objective.

Shared solver contract:

- Fit Here and Auto Preview must use the same backend rescue/removal engine.
- Fit Here evaluates only the clicked anchor gap.
- Auto Preview enumerates every valid anchor in the current route and feeds each candidate into the same solver.
- These rules are shared; do not fork a second rule set for the auto path.

The exact clicked anchor is tried first.
If it fails because of cross-city direction, backtracking, route end, or operating hours, do not immediately return `CANNOT_FIT`.
Continue rescue.
Return `CANNOT_FIT` only when the selected manual hotspot cannot fit after all allowed non-manual removal and reorder attempts are exhausted.

## Preview and confirm contract

If preview says `canConfirm=true`, the finalized preview timeline is the thing we intend to save.

That means confirm is not allowed to run a second independent fit decision and contradict preview when the route has not changed.

Required behavior:

- preview must store the finalized timeline snapshot plus a fingerprint of that snapshot
- confirm must compare the live route fingerprint with the preview source fingerprint
- if the source fingerprint is unchanged and the stored preview snapshot is still valid, confirm must trust preview
- confirm must not re-fail with:
  - `MANUAL_INSERT_NO_LOW_PRIORITY_REMOVAL_AVAILABLE`
  - `MANUAL_INSERT_EXCEEDS_DAY_END`
- the only acceptable confirm rejection after `canConfirm=true` is:
  - route changed after preview, so request is stale
  - stored preview snapshot is missing or corrupted

Corrupted preview guard:

- if `canConfirm=true` but stored finalized preview snapshot is missing, malformed, or fingerprint-mismatched, backend must reject with a dedicated corruption-style error
- do not silently recompute a different plan and pretend it is the same preview

## Route-scoped simulation rule

Manual Fit Here preview must simulate the clicked route only.

Allowed:

- active hotspot rows from the clicked route
- travel and hotel legs derived from the clicked route
- the selected manual hotspot being inserted
- allowed same-route removals and reorders

Forbidden:

- importing attractions from another day of the same itinerary
- importing sibling-route hotspots because they look directionally convenient
- rebuilding from hidden fallback rows that were not part of the clicked route source array

This prevents wrong previews such as:

```text
Day 2 clicked route: Alagar Koyil -> Pamban Bridge
Preview result: Ramanatha -> Pamban -> APJ -> Agni -> Hotel
```

That is invalid because `Ramanatha` and `Agni` were not part of the clicked route scope.

## Plain-English APJ selected-pivot rule

APJ is the selected manual hotspot, so APJ must win.

The route is:

```text
Madurai -> Rameshwaram
```

Once APJ is inserted, the route has entered the Rameshwaram side.

After APJ, the system must not send the customer back to Madurai-side attractions like Meenakshi or Thirumalai.

Wrong:

```text
Refreshment -> APJ -> Thirumalai -> Hotel
```

Because it means:

```text
Madurai -> Rameshwaram -> Madurai
```

That backtracking must be avoided by removing or repositioning Thirumalai if policy allows.

The backend should not think:

```text
Can I keep all attractions somehow?
```

The backend should think:

```text
Can I fit APJ at or near the clicked target?
After APJ, can I keep only valid same-direction Rameshwaram attractions?
Which Madurai/backtracking or operating-hour blockers must be removed?
```

Exact business rule:

- APJ selected manual hotspot is the pivot.
- Clicked anchor is tried first.
- If clicked anchor blocks APJ, remove or reposition allowed blockers.
- After APJ, do not go back to Madurai-side hotspots.
- Always explain removals by reason: backtracking, operating hours, route end, or policy.

## Different-city route rules

Different-city route example:

```text
Madurai -> Rameshwaram
```

Source-side / Madurai hotspots:

- Meenakshi Amman Temple
- Thirumalai Nayakkar Mahal

Destination-side / Rameshwaram hotspots:

- APJ Abdul Kalam National Memorial
- Ramanatha Swamy Temple
- Agni Teertham

APJ is destination-side.
Once APJ is inserted, APJ becomes the directional pivot.
After APJ, source-side / Madurai hotspots become backtracking blockers.

The system must not produce:

```text
Madurai -> Rameshwaram -> Madurai -> Hotel
```

Invalid:

```text
Refreshment -> APJ -> Thirumalai -> Hotel
```

Valid:

```text
Refreshment -> APJ -> Ramanatha -> Agni -> Hotel
```

## Operating-hours handling

For every kept survivor:

- If arrival is before opening time, wait until opening.
- If visit can finish inside operating hours, keep it.
- If arrival or visit crosses closing time, remove it if policy allows.
- Give a clear removal reason:
  - reached after operating hours
  - visit crosses closing
  - route-end overflow
  - backtracking
  - selected hotspot cannot fit unless this blocker is removed
- Do not remove simply because arrival is early. Waiting is allowed.
- Do not keep a hotspot visited after closing.
- If a hotspot has a later same-day opening window, the solver may wait for that later window when the route still fits.
- That later-window wait is allowed for manual or stronger-priority insertions.
- Priority 0 auto hotspots should not wait across a long closed gap just to catch a later shift.

Selected-hotspot rule:

- `SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME` is allowed as a final preview state only after all allowed same-route rescue removals have already been tried
- do not stop at the first closed attempted time if upstream blockers are still removable
- if upstream blocker removal makes the selected hotspot fit inside operating hours, selected hotspot wins

## Removal disclosure rule

Preview removal messaging must match the finalized preview timeline.

If finalized preview dropped route hotspots to make confirmation possible:

- those hotspots must appear in `removedHotspots`
- those hotspots must appear in `changesRequiredDisplay.removedItems`
- result type must be `FITS_WITH_OPTIONAL_REMOVAL`, not `FITS_DIRECTLY`

Do not show:

- `No hotspot removed`

when finalized preview actually removed attractions from the route.

## Destination-side APJ examples for Madurai -> Rameshwaram

### Case A: APJ before all attractions

Clicked position:

```text
Refreshment -> APJ
```

Expected logic:

```text
Refreshment
-> APJ
-> try Ramanatha
-> try Agni
-> Hotel
```

Rules:

- Fit APJ from refreshment/start first.
- Meenakshi and Thirumalai are Madurai-side, so after APJ they become backtrack blockers.
- Remove Meenakshi if non-manual and policy allows.
- Remove Thirumalai if non-manual and policy allows.
- Try Ramanatha after APJ.
  - If reached before opening, wait.
  - If reached within operating hours, keep.
  - If reached after closing or visit crosses closing, remove with reason.
- Try Agni after APJ with the same operating-hours logic.
- Do not return `CANNOT_FIT` unless APJ itself cannot fit after all allowed rescue removals.
- Never return confirmable timeline like:

```text
Refreshment -> APJ -> Thirumalai -> Hotel
```

Example removal reasons:

- Thirumalai removed because it is source-side after destination-side APJ and causes backtracking.
- Ramanatha removed because arrival or visit crossed operating hours.
- Agni removed because arrival or visit crossed operating hours.

### Case B: APJ after Meenakshi

Clicked position:

```text
Meenakshi -> APJ
```

First try to keep Meenakshi because it is clicked anchor and P1:

```text
Refreshment
-> Meenakshi
-> APJ
-> Ramanatha
-> Agni
-> Hotel
```

Rules:

- Try to keep Meenakshi first because it is clicked anchor and P1.
- After APJ, Thirumalai is Madurai-side, so remove it even if P2 because it causes backtracking.
- Try Ramanatha P2 after APJ using operating-hours logic.
- Try Agni P3 after APJ using operating-hours logic.
- If keeping Meenakshi makes APJ too late or APJ cannot fit, remove Meenakshi also if non-manual and policy allows.
- Rescue order is not simply "never remove P1."
- Try to keep P1 anchor first, but if APJ cannot fit, APJ wins and Meenakshi can also be removed if non-manual and allowed.
- Never fake success by placing APJ later after Thirumalai, Ramanatha, or Agni.
- Do not return empty `CANNOT_FIT` while Thirumalai, Ramanatha, Agni, or Meenakshi are removable rescue candidates.

### Case C: APJ after Thirumalai

Clicked position:

```text
Thirumalai -> APJ
```

First try:

```text
Refreshment
-> Meenakshi
-> Thirumalai
-> APJ
-> Ramanatha
-> Agni
-> Hotel
```

Rules:

- Meenakshi and Thirumalai are before APJ in the literal attempt, so they are not backtracking yet.
- If APJ cannot fit because it becomes too late:
  - try removing Meenakshi
  - try removing Thirumalai
  - try removing both
- Then retry APJ earlier.
- After APJ fits, continue only with Rameshwaram-side attractions:
  - Ramanatha
  - Agni
  - Hotel
- Ramanatha and Agni must be checked by operating hours:
  - reached before opening -> wait
  - reached within opening -> keep
  - reached after closing -> remove with reason
- Do not return `CANNOT_FIT` until all allowed removal combinations have been tried.

### Case D: APJ after Ramanatha

Clicked position:

```text
Ramanatha -> APJ
```

First try:

```text
Refreshment
-> Meenakshi
-> Thirumalai
-> Ramanatha
-> APJ
-> Agni
-> Hotel
```

Rules:

- First try exact anchor Ramanatha -> APJ.
- If APJ is closed because it is reached too late, do not immediately return `CANNOT_FIT`.
- Rescue is required.
- Ramanatha and Thirumalai can both be P2 or tie-type blockers.
- Try both tie directions:
  1. Remove Thirumalai, keep Ramanatha, then try APJ.
  2. Keep Thirumalai, remove Ramanatha, then try APJ if directionally valid.
  3. Remove both Thirumalai and Ramanatha, then try APJ.
- Whichever gives APJ a valid operating-hours fit should be accepted.
- If APJ still does not fit, remove Meenakshi also if non-manual and policy allows.
- Once APJ fits, try Agni after APJ.
- Agni is destination-side, so it is allowed after APJ, but it still must pass operating hours.
- Return `CANNOT_FIT` only if APJ cannot fit after all allowed removals and reorders.

### Case E: APJ after Agni

Clicked position:

```text
Agni -> APJ
```

First build normally:

```text
Refreshment
-> Meenakshi
-> Thirumalai
-> Ramanatha
-> Agni
-> APJ
-> Hotel
```

Rules:

- First try exact anchor Agni -> APJ.
- If Agni itself cannot fit after Ramanatha, do not blindly keep Agni and fail APJ.
- APJ is selected manual hotspot, so APJ wins.
- Try removing or reordering earlier blockers.
- Try making APJ fit.
- Then decide whether Agni can remain before APJ or must be removed or repositioned.
- If Agni blocks APJ, Agni may be removed or repositioned if non-manual and policy allows.
- Return `CANNOT_FIT` only if APJ cannot fit after all allowed rescue attempts.

## Key selected-hotspot-first algorithm

For every clicked Fit Here position:

1. Try the exact clicked position first.
2. If APJ fits there, continue rebuilding after APJ.
3. After APJ, remove source-side Madurai blockers.
4. Try destination-side Rameshwaram attractions after APJ.
5. For every remaining attraction:
   - if early, wait
   - if within operating hours, keep
   - if late or closed, remove with clear reason
6. If APJ itself does not fit:
   - progressively remove allowed non-manual blockers
   - try tied priority removals both ways
   - retry APJ after each removal set
7. Return `CANNOT_FIT` only when APJ cannot fit even after all allowed removals.

Implementation note:

- The backend should treat this as a bounded selected-hotspot-first candidate-array search.
- Each state is a candidate attraction array plus removed hotspot IDs and rescue reasons.
- The solver should rank states by:
  1. selected manual hotspot preserved
  2. fewer removals
  3. clicked anchor preserved if possible
  4. fewer high-priority removals
  5. fewer operating-hours conflicts
  6. lower route-end overflow
  7. less waiting
- Exact-anchor rescue should therefore behave like best-first graph search over candidate arrays, not one cumulative removal path.

## Removal and candidate rules

Removal policy:

Never remove:

- selected manual hotspot
- already-active manual hotspots
- protected manual rows
- non-removable rows according to policy

May remove or reposition if policy allows:

- non-manual P4
- non-manual P3
- non-manual P2
- non-manual P1
- clicked anchor itself, only after literal clicked-anchor attempt fails and only if non-manual and policy allows

Candidate ranking:

1. Selected manual hotspot preserved
2. Fewer total removals
3. Clicked anchor preserved if possible
4. Fewer high-priority removals
5. Fewer operating-hours conflicts
6. Lower route-end overflow
7. Less waiting
8. Less detour

Tie priority:

When two blockers have the same priority, try both removal orders before deciding.

## Backend implementation requirements

The backend must implement selected-hotspot-first rescue.

Required behavior:

1. Try literal clicked anchor first.
2. If literal clicked anchor succeeds, finalize.
3. If literal clicked anchor fails:
   - do not immediately `CANNOT_FIT`
   - generate rescue removal and reorder candidates
   - remove or reposition allowed non-manual blockers
   - for different-city route, apply direction pivot logic
   - validate operating hours
   - validate route end and manual timing
4. Return best feasible candidate.
5. Return `CANNOT_FIT` only after all allowed candidates fail.

Different-city direction pivot:

If selected hotspot is `DESTINATION_CITY`:

- selected hotspot becomes pivot
- after selected hotspot, keep `DESTINATION_CITY` survivors first
- `SOURCE_CITY` rows after selected hotspot are backtracking blockers and must be removed or repositioned if policy allows
- `UNKNOWN` rows can be tried after same-side survivors but before opposite-side blockers only if route remains feasible

If selected hotspot is `SOURCE_CITY`:

- reverse the same logic
- after selected source-side hotspot, destination-side rows before completing source flow may be repositioned or removed if they cause backtracking

Same-city route:

Do not apply source/destination pruning.
Use exact-anchor attempt, local shuffle or reorder, matrix, operating hours, and allowed removals.

Opening-hours rescue:

Do not return `SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME` as final if allowed blockers remain.
If selected APJ is closed at first attempted time, try removing or reordering earlier blockers to make APJ earlier.
Only after all removals fail can final `CANNOT_FIT` be returned.

Fake success forbidden:

Do not return `canConfirm=true` when:

- APJ exists somewhere later but not at or near selected Fit Here target
- User clicked after Meenakshi but APJ appears after Thirumalai, Ramanatha, or Agni
- User clicked after Ramanatha but APJ appears after Agni
- `APJ -> Thirumalai -> Hotel` in Madurai -> Rameshwaram
- Any destination-side APJ timeline goes back to source-side Madurai hotspot after APJ
- `selectedHotspotPreserved=true` is set only because APJ appears somewhere late

## Exact-anchor stale rule

The backend must reject stale clicked gaps instead of silently drifting to another gap.

Return:

- HTTP `409`
- code `MANUAL_FIT_HERE_ANCHOR_STALE`

Examples of stale conditions:

- requested `afterRouteHotspotId` no longer exists on the active route
- requested `beforeRouteHotspotId` no longer exists on the active route
- requested adjacency no longer matches the active route
- `AFTER_START` still points to an old first attraction

## Verified examples

### Example A: confirm must trust preview

Observed live behavior after fix:

- preview `canConfirm=true`
- route fingerprint unchanged
- confirm returns `201`
- confirm does not re-fail with day-end or low-priority-removal errors

Verified cases:

- plan `9825`, route `8154`, selected hotspot `898`, anchor `After Echo Point`
- plan `9822`, route `8119`, before-first-attraction confirm flow
- plan `9824`, route `8140`, before-first-attraction confirm flow

### Example B: Munnar selected-closing rescue

Clicked route:

```text
Echo Point -> Mattupetty Dam and Lake -> ...
```

Selected manual hotspot:

```text
Munnar
```

Wrong historical behavior:

- preview kept `Echo Point` before `Munnar`
- `Munnar` was attempted after its `10:00 AM` close
- backend stopped with selected-closed result too early

Correct behavior:

- remove eligible upstream blocker from the clicked route
- rebuild from route start if needed
- move `Munnar` earlier
- return confirmable result only if `Munnar` is now inside operating hours

Verified fixed case:

- plan `9825`, route `8154`, selected hotspot `898`, anchor `After Echo Point`
- removal: `Echo Point`
- confirm succeeded with `201`

### Example C: stale anchor after route changed

If preview was captured before an earlier confirm changed the route:

- the old clicked gap is no longer authoritative
- backend must return `MANUAL_FIT_HERE_ANCHOR_STALE`

This is the correct outcome, not a regression.

## Verification workflow

Reusable regression script:

```bash
npm run verify:manual-fit:sweep
```

Full preview-plus-confirm sweep:

```bash
npm run verify:manual-fit:sweep:confirm
```

Useful options:

```bash
npm run verify:manual-fit:sweep:confirm -- --planIds=9822,9824 --json=true
```

Script guarantees:

- replays known manual-fit regression payloads
- sweeps recent or specified plans day by day
- picks a live available manual hotspot candidate for each route
- runs preview
- optionally runs confirm
- reports preview `409`, stale-anchor cases, selected-closed cases, and confirm `409`

Important note:

- `--confirm=true` mutates live itinerary data because it saves the manual hotspot into the route

Response consistency:

If APJ is rescued but clicked anchor is not preserved:

- `canConfirm=true`
- `selectedHotspotPreserved=true`
- `selectedAnchorPreserved=false`
- `resultType` should be a success or rescue type, not `CANNOT_FIT`
- `timeline` must show the rescued valid timeline
- `removedHotspots` and `authoritativeRemovedHotspotIds` should show removed blockers with reasons

If APJ truly cannot fit:

- `resultType=CANNOT_FIT`
- `canConfirm=false`
- `selectedHotspotPreserved=false`
- `selectedAnchorPreserved=false`
- `authoritativeTimelineSource=EXACT_ANCHOR_NO_VALID_RESULT` or a better final failure source
- `proposedTimeline=[]`
- `finalizedTimeline=[]`
- `removedHotspots=[]`
- `authoritativeRemovedHotspotIds=[]`

Never return:

- `selectedAnchorPreserved=true` with `EXACT_ANCHOR_NO_VALID_RESULT`
- non-empty timeline with `EXACT_ANCHOR_NO_VALID_RESULT`
- `CANNOT_FIT` while allowed non-manual blockers remain untried
- success just because APJ exists somewhere later in route
- failure just because literal clicked anchor could not be preserved

## Current enforced backend guardrails

These are not just desired rules.
These are the guardrails now enforced by the current backend code.

### 1. Route-scoped preview isolation

Manual Fit Here preview for a route must simulate only that route.

When preview is requested for route `R`:

- keep only active hotspot rows that belong to route `R`
- allow manual placeholders that also belong to route `R`
- do not pull hotspot rows from sibling routes of the same itinerary
- do not rebuild the day using other route rows just because they exist elsewhere in the plan

Practical meaning:

- If day 2 currently has only `Alagar Koyil` and `Pamban Bridge`, then preview for that day must start from that visible day-2 hotspot set.
- Adding APJ must not suddenly import `Ramanatha Swami Temple`, `Agni Teertham`, or any hotspot that belongs to another route or another day unless the user explicitly added it on this same route.

Implementation note:

- Preview mode now applies a route-scoped hotspot filter.
- Current logging rule:
  - `SCOPED_PREVIEW_ROUTE_HOTSPOT_FILTER`

### 2. Visible timeline only for exact-anchor rescue

Exact-anchor rescue must be based on the visible route timeline that the user clicked.

Do not silently widen the rescue candidate array by re-reading extra persisted route attractions from the database when those rows are not part of the source preview timeline.

Allowed:

- build rescue candidates from the exact timeline array the user is previewing
- preserve current route rows
- add the selected manual hotspot
- remove allowed blockers from that same route-scoped array

Forbidden:

- rehydrating missing attractions from DB and mixing them back into preview rescue
- using hidden persisted rows to manufacture a different day plan than the one user clicked
- showing a preview timeline with hotspots the user never saw in that day

This is the main rule that prevents false previews like:

```text
Visible day: Alagar -> Pamban
Preview result: Ramanatha -> Pamban -> APJ -> Agni -> Hotel
```

That output is invalid because the preview stopped simulating the clicked day and started rebuilding from external DB rows.

### 3. Stale exact-anchor requests must fail fast

Fit Here anchor payload is valid only while the backend route still matches the clicked UI timeline.

If the user clicked an anchor using old route-hotspot IDs or an old adjacency gap, preview must not silently "best effort" another location.

Return conflict instead.

Current conflict contract:

- HTTP `409`
- code: `MANUAL_FIT_HERE_ANCHOR_STALE`

Current stale reasons include:

- `afterRouteHotspotId` no longer active on this route
- `beforeRouteHotspotId` no longer active on this route
- `afterHotspotId` or `beforeHotspotId` no longer active on this route
- requested `after -> before` gap is no longer adjacent on the active route
- `AFTER_START` request points to a first hotspot that no longer matches the current route start

Response should include:

- `reasons`
- `currentRouteHotspots`

Why this matters:

- stale requests previously fell through to generic fallback logic
- that created fake success, wrong removals, or wrong "cannot fit" decisions on a route the user was no longer actually previewing

### 4. Selected-hotspot closing conflict is a real block

If the selected hotspot is closed at the attempted visit time, preview must report that final state as a blocking result unless another rescue candidate truly makes it fit earlier.

Do not mark preview confirmable merely because some internal payload looked "ready to apply."

Current enforced result type:

- `SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME`

Meaning:

- if selected hotspot still lands outside operating hours in the chosen candidate
- confirm must remain disabled
- UI must not show "Can Fit Directly"

### 4A. Exact-anchor selected-closing rescue removes upstream blockers first

When the selected hotspot is closed only because earlier same-route attractions push it too late, exact-anchor preview must try a direct upstream-blocker rescue before returning a final closing block.

Current enforced behavior:

- stay inside the clicked route-scoped attraction array
- inspect attractions before the selected hotspot
- try removing the nearest eligible blocker first
- then try larger cumulative upstream removal sets if one removal is not enough
- after each removal set, rebuild the selected hotspot and all downstream rows
- accept the first candidate where:
  - selected hotspot fits inside operating hours
  - route end still fits
  - no selected-opening conflict remains

This is the current fix for cases like:

```text
Echo Point -> Munnar
Mattupetty -> Munnar
```

where `Munnar` is selected and reaches its `08:00 AM - 10:00 AM` operating-hours window too late unless earlier blockers are removed.

Expected result shape:

- `resultType = FITS_WITH_OPTIONAL_REMOVAL`
- `canConfirm = true`
- `selectedOpeningConflict = null`
- removed blockers are listed with reason:
  - `<blocker> removed because selected manual hotspot <selected> must fit before operating-hours closing.`

### 4B. Rebuild downstream after rescue, do not keep stale first-leg travel

Once an upstream blocker is removed for selected-closing rescue, preview must not keep a stale first travel leg that still points to the removed hotspot.

Example of forbidden stale carry-over:

```text
Travel to Echo Point
Echo Point
Travel to Munnar
Munnar
```

after `Echo Point` was already removed.

Current enforced behavior:

- when the selected hotspot becomes the first attraction after rescue
- only reuse a source-like initial travel replica if it really starts from hotel / route start
- otherwise recalculate the source-to-selected travel leg

### 4C. Current code does not yet perform deferred reinsertion of removed blockers

After selected-closing rescue succeeds, current backend behavior is:

- keep the selected hotspot fixed at the rescued earlier time
- rebuild the downstream route
- keep removed blockers removed

Current backend does **not** yet do a second-pass "reinsert removed blocker later if a valid downstream gap exists" search.

So for now:

- do not expect `Echo Point` to be automatically re-added later in the same preview
- do not document later reinsertion as current behavior
- if later reinsertion is implemented in the future, update this section and the exact-anchor rules document together

### 5. Exact-anchor fallback is allowed only when source exact timeline is empty

For exact-anchor validation, falling back to active-route DB candidates is now heavily restricted.

Allowed fallback:

- exact-anchor mode
- candidate array is empty
- source exact timeline has zero attraction rows

Not allowed fallback:

- exact-anchor mode with a non-empty source timeline
- selected-hotspot closing validation where the clicked timeline already contains route attractions

Reason:

- if the user already clicked a real visible day timeline, exact rescue must stay rooted in that visible array
- otherwise confirm preview stops representing what the user clicked

### 6. Different-city selected-pivot rescue may defer clicked anchor, but only inside the same route-scoped array

For different-city routes, the selected hotspot can still win over the clicked anchor when needed for directional correctness or closing-time rescue.

That part remains valid.

But the rescue is bounded by two hard rules:

- do not import foreign/sibling-day hotspots
- do not preserve a fake clicked anchor by moving the selected hotspot to an unrelated later position

So the current mental model is:

```text
Take the clicked route's visible hotspot array
+ selected manual hotspot
- allowed blockers
-> rebuild
```

Not:

```text
Take whole itinerary memory
-> search anywhere for a success-looking path
```

## Frontend meaning

`ManualFitHerePreviewDialog.tsx` must:

- trust backend final `canConfirm`
- disable confirm when `canConfirm=false`
- not show success when final `resultType=CANNOT_FIT`
- show rescued timeline when `canConfirm=true` even if `selectedAnchorPreserved=false`
- show removed or repositioned hotspots with clear user-facing reasons
- distinguish:
  1. exact clicked anchor not preserved, but selected APJ rescued
  2. selected APJ truly cannot fit
- do not hide timeline only because exact-anchor mismatch metadata exists if `canConfirm=true`

## Validation checklist

- Exact-anchor preview uses the selected-hotspot-first rescue path.
- The clicked anchor is tried before rescue.
- APJ is treated as the pivot on different-city Madurai -> Rameshwaram routes.
- Backtracking blockers after APJ are removed or repositioned if policy allows.
- Operating-hours waiting is allowed for early arrivals.
- A hotspot visited after closing is removed.
- Preview uses only the clicked route's hotspot set plus same-route manual placeholders.
- Preview does not import sibling-route or other-day hotspots.
- Stale anchor payloads return `409 MANUAL_FIT_HERE_ANCHOR_STALE`.
- Exact-anchor rescue does not silently widen from DB when the source route timeline is already populated.
- `SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME` cannot be surfaced as confirmable success.
- Final `CANNOT_FIT` only happens after all allowed rescue attempts fail.
- Successful rescue can keep `canConfirm=true` even when the clicked anchor is not preserved.

## Debugging checklist for future regressions

When preview looks wrong, check in this order:

1. Is the clicked anchor stale?
   - Compare payload `afterRouteHotspotId` and `beforeRouteHotspotId` with current active route rows.
2. Did preview import hotspots from another day or sibling route?
   - If yes, route-scoped preview isolation is broken.
3. Did exact-anchor rescue widen from DB even though the clicked route already had visible attractions?
   - If yes, visible-timeline-only rule is broken.
4. Did preview show `Can Fit` while the selected hotspot is still outside operating hours?
   - If yes, selected-hotspot closing guard is broken.
5. Did rescue remove blockers from the same route in allowed order?
   - If no, rescue ordering or route scoping is broken.

Expected debugging evidence:

- active route hotspot IDs
- clicked payload route-hotspot IDs
- selected hotspot attempted time
- selected hotspot operating hours
- removed hotspot IDs with reasons
- final preview hotspot IDs in order

## Real payload examples

These examples are included so future debugging can compare actual behavior against known fixed cases.

### Example 1: route-scoped preview must not import sibling-day hotspots

Plan:

- `planId=9823`
- `routeId=8175`
- selected hotspot: `41` = `APJ Abdul Kalam National Memorial`

Clicked anchor:

```json
{
  "routeId": 8175,
  "selectedHotspotId": 41,
  "anchor": {
    "anchorType": "BETWEEN_ROWS",
    "anchorIntent": "AFTER_ATTRACTION",
    "anchorIndex": 6,
    "anchorFrom": "Pamban Bridge",
    "anchorTo": "Travel to Hotel",
    "anchorLabel": "After Pamban Bridge",
    "anchorTimeRange": "05:15 PM - 05:30 PM",
    "afterRowType": "attraction",
    "beforeRowType": "travel",
    "afterHotspotId": 40,
    "afterRouteHotspotId": 147208,
    "beforeHotspotId": null,
    "beforeRouteHotspotId": null
  },
  "allowP3Removal": true,
  "allowP1P2Removal": true
}
```

Ground truth active hotspot set for route `8175`:

- `28` = `Alagar Koyil & Palamuthircholai Murugan Temple`
- `40` = `Pamban Bridge`

Wrong historical preview:

```text
Ramanatha -> Pamban -> APJ -> Agni -> Hotel
```

Why wrong:

- `Ramanatha` and `Agni` were not part of active route `8175`
- preview leaked hotspots from sibling route/day state

Correct rule now:

- preview for route `8175` may only rebuild from the current route set
- after APJ insertion, allowed output must stay bounded to:
  - current route hotspots
  - selected manual hotspot
  - allowed removals from that same route

### Example 2: stale anchor payload must return conflict, not fake success

Plan:

- `planId=9823`
- `routeId=8171`

If frontend sends an old `afterRouteHotspotId` / `beforeRouteHotspotId` pair that is no longer active or no longer adjacent on route `8171`, backend must not silently remap the click.

Correct behavior now:

```text
HTTP 409
code: MANUAL_FIT_HERE_ANCHOR_STALE
```

Response must explain:

- which route-hotspot IDs are stale
- whether the requested gap is no longer adjacent
- what the current active route hotspots are

### Example 3: selected hotspot closing conflict must stay blocked

If preview still lands the selected hotspot outside operating hours, backend must return:

```text
resultType = SELECTED_HOTSPOT_CLOSED_AT_ATTEMPTED_TIME
canConfirm = false
```

It must not show:

```text
Can Fit Directly
```

just because an internal candidate was otherwise marked ready.

### Example 4: route 8154 Munnar rescue after Echo Point

Plan:

- `planId=9825`
- `routeId=8154`
- selected hotspot: `898` = `Munnar`

Clicked anchor:

```json
{
  "routeId": 8154,
  "selectedHotspotId": 898,
  "anchor": {
    "anchorType": "BETWEEN_ROWS",
    "anchorIntent": "AFTER_ATTRACTION",
    "anchorIndex": 3,
    "anchorFrom": "Echo Point",
    "anchorTo": "Mattupetty Dam and Lake",
    "anchorLabel": "After Echo Point",
    "anchorTimeRange": "09:46 AM - 10:31 AM",
    "afterRowType": "attraction",
    "beforeRowType": "hotspot",
    "afterHotspotId": 483,
    "afterRouteHotspotId": 128357,
    "beforeHotspotId": 223,
    "beforeRouteHotspotId": 128363
  },
  "allowP3Removal": true,
  "allowP1P2Removal": true
}
```

Verified fixed response shape:

- `resultType = FITS_WITH_OPTIONAL_REMOVAL`
- `canConfirm = true`
- `selectedOpeningConflict = null`
- removed hotspot: `483 = Echo Point`
- selected hotspot `Munnar` moves earlier and no longer remains after `Echo Point`

### Example 5: route 8154 Munnar rescue after Mattupetty

Plan:

- `planId=9825`
- `routeId=8154`
- selected hotspot: `898` = `Munnar`

Clicked anchor:

```json
{
  "routeId": 8154,
  "selectedHotspotId": 898,
  "anchor": {
    "anchorType": "BETWEEN_ROWS",
    "anchorIntent": "AFTER_ATTRACTION",
    "anchorIndex": 5,
    "anchorFrom": "Mattupetty Dam and Lake",
    "anchorTo": "Munnar Rose Garden",
    "anchorLabel": "After Mattupetty Dam and Lake",
    "anchorTimeRange": "11:01 AM - 12:01 PM",
    "afterRowType": "attraction",
    "beforeRowType": "hotspot",
    "afterHotspotId": 223,
    "afterRouteHotspotId": 128363,
    "beforeHotspotId": 220,
    "beforeRouteHotspotId": 128368
  },
  "allowP3Removal": true,
  "allowP1P2Removal": true
}
```

Verified fixed response shape:

- `resultType = FITS_WITH_OPTIONAL_REMOVAL`
- `canConfirm = true`
- `selectedOpeningConflict = null`
- removed hotspots:
  - `223 = Mattupetty Dam and Lake`
  - `483 = Echo Point`
- selected hotspot `Munnar` moves earlier and no longer remains after those blockers

## Validation commands

Backend:

```bash
cd api.dvi.travel
npm run build
FIT_TOKEN="PASTE_TOKEN" FIT_PLAN_ID=9706 node scripts/debug-fit-here-dvi2026071.js
```

Frontend:

```bash
cd dvi_frontend
npm run build
```

Playwright if a focused regression spec is added:

```bash
npx playwright test <spec-path> --project=chromium --headed
```
