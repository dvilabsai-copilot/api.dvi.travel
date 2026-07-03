# Manual Hotspot Reorder And Removal Rules

## Core principle

Manual Fit Here is not a generic best-fit insertion.

The selected manual hotspot is the primary objective.

The exact clicked anchor is tried first.
If it fails because of cross-city direction, backtracking, route end, or operating hours, do not immediately return `CANNOT_FIT`.
Continue rescue.
Return `CANNOT_FIT` only when the selected manual hotspot cannot fit after all allowed non-manual removal and reorder attempts are exhausted.

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
- Final `CANNOT_FIT` only happens after all allowed rescue attempts fail.
- Successful rescue can keep `canConfirm=true` even when the clicked anchor is not preserved.

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
