# TESTING.md

## Step 1 Manual Tests: Preview Hotspot Isolation

Scope: Validate preview-add hotspot has zero persistent DB side effects while preserving preview payload and keeping actual add behavior unchanged.

### Preconditions
- Use an itinerary with at least one route and available hotspot candidates.
- Identify values:
  - `planId`
  - `routeId`
  - `hotspotId` (not already manually added for that route)
- Endpoint under test:
  - `POST /itineraries/hotspots/preview-add`
  - `POST /itineraries/hotspots/add`

### DB Check Query Template
Use this before/after each test run:

```sql
SELECT COUNT(*) AS cnt
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = <planId>
  AND itinerary_route_ID = <routeId>
  AND hotspot_ID = <hotspotId>
  AND item_type = 4
  AND deleted = 0;
```

## Test 1: Preview add hotspot twice does not persist rows
1. Run baseline DB query and record `cnt_before`.
2. Call `POST /itineraries/hotspots/preview-add` once.
3. Call `POST /itineraries/hotspots/preview-add` again with same payload.
4. Run DB query again and record `cnt_after`.
5. Expected:
- `cnt_after == cnt_before`
- No new persistent row created by preview calls.

## Test 2: Preview still returns expected timeline/conflict payload
1. Call `POST /itineraries/hotspots/preview-add`.
2. Validate response still includes existing preview structure keys:
- `newHotspot`
- `otherConflicts`
- `shiftedItems`
- `droppedItems`
- `fullTimeline`
- `includedRouteIds`
- `nextRouteIncluded`
3. Expected:
- Response shape remains compatible with existing frontend preview UI.

## Test 3: Actual add hotspot still persists exactly once
1. Run baseline DB query and record count.
2. Call `POST /itineraries/hotspots/add` once with same `planId`, `routeId`, `hotspotId`.
3. Run DB query again.
4. Expected:
- Count increases by exactly 1 compared to baseline.
- Timeline recalculation succeeds.

## Test 4: Preview followed by actual add does not create duplicates
1. Run baseline DB query and record count.
2. Call preview endpoint once.
3. Call add endpoint once.
4. Run DB query again.
5. Expected:
- Total increase is exactly 1.
- No duplicate row caused by preview + add sequence.

## Test 5: Preview real errors are propagated (not swallowed)
1. Call `POST /itineraries/hotspots/preview-add` with an invalid `routeId` (or invalid `planId`/`hotspotId` combination).
2. Expected:
- API returns an error response (4xx/5xx depending on validation path), not a success payload.
- No new row is persisted in `dvi_itinerary_route_hotspot_details`.
- Confirms rollback marker handling does not swallow unrelated runtime errors.

## Notes
- If count changes during preview-only tests, preview isolation is broken.
- If add endpoint does not increase count by 1 after preview, verify route/hotspot eligibility and existing manual entries.

## Step 2 Manual Tests: Manual Hotspot Endpoint Parity

Scope: Validate frontend manual hotspot add uses dedicated manual-hotspot endpoint and remove flow remains correct.

### Test 6: Manual hotspot add uses correct endpoint
1. Open itinerary details UI and trigger manual hotspot add from hotspot preview modal.
2. Inspect network request in browser dev tools.
3. Expected:
- Request URL is `POST /itineraries/{planId}/manual-hotspot`.
- Request body contains `routeId` and `hotspotId`.
- Request does not use `POST /itineraries/hotspots/add` for manual add flow.

### Test 7: Manual hotspot persists correctly
1. Add manual hotspot through UI.
2. Refresh itinerary details.
3. Expected:
- Manual hotspot is present in timeline after reload.
- No duplicate insertions for a single add action.

### Test 8: Manual hotspot remove works
1. Remove the manual hotspot from itinerary details.
2. Refresh itinerary details.
3. Expected:
- Manual hotspot is removed.
- Remove flow still calls `DELETE /itineraries/{planId}/manual-hotspot/{hotspotId}` and succeeds.

### Test 9: Preview plus manual add does not duplicate
1. Preview add a hotspot.
2. Confirm add from manual hotspot action.
3. Refresh itinerary details.
4. Expected:
- Final timeline contains the hotspot once.
- No duplicate manual hotspot rows created by preview + add sequence.

## Step 3 Manual Tests: Delete Activity Rebuild Behavior

Scope: Validate deleting an activity triggers full route/day timeline recalculation and does not create duplicate rows.

### Test 10: Delete activity in middle of day triggers reroute
1. Create/select itinerary day with multiple hotspots and at least one activity in a mid-day hotspot.
2. Delete the mid-day activity from itinerary details.
3. Refresh itinerary details.
4. Expected:
- Downstream timeline is recalculated (not only timestamp update).
- Travel/visit sequence after deleted activity reflects recalculated schedule.

### Test 11: Timeline recalculated after delete
1. Capture before-delete time ranges for remaining hotspots in the route.
2. Delete one activity.
3. Compare post-delete time ranges.
4. Expected:
- Route timeline reflects recalculation across impacted segments.
- No stale gap caused by removed activity slot.

### Test 12: No duplicate rows after delete-triggered rebuild
1. Delete one activity and refresh itinerary.
2. Validate timeline UI for duplicate hotspot segments.
3. Run DB checks for duplicates:
```sql
SELECT itinerary_route_ID, hotspot_ID, hotspot_start_time, hotspot_end_time, COUNT(*) AS cnt
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = <planId>
  AND deleted = 0
GROUP BY itinerary_route_ID, hotspot_ID, hotspot_start_time, hotspot_end_time
HAVING COUNT(*) > 1;
```
4. Expected:
- Query returns no rows for unintended duplicates.

### Test 13: Delete activity near end of route
1. Delete an activity scheduled close to route end time.
2. Refresh itinerary details.
3. Expected:
- Recalculated end-of-day timeline remains valid.
- No broken final travel/return segments.

### Test 14: Delete activity that had shifted downstream items
1. Use a case where activity addition previously shifted later segments.
2. Delete that activity.
3. Refresh itinerary details.
4. Expected:
- Downstream items are recalculated coherently after delete.
- No duplicate hotspot/activity rows are introduced.

## Step 4 Manual Tests: Scoring Priority Normalization

Scope: Validate hotspot scoring follows business precedence: priority first, distance second, city order last.

Step 4.1 activation note:
- Scoring logic is now active in timeline.builder.ts comparator (fetchSelectedHotspotsForRoute).

### Test 15: Priority 1 selected before priority 4
1. Use a route where candidate hotspot set includes at least one priority 1 and one priority 4 hotspot.
2. Trigger itinerary rebuild/optimization for that route.
3. Expected:
- Priority 1 hotspot appears before priority 4 in selected/scheduled order when both are feasible.

### Test 16: Priority 2 selected before priority 5
1. Use a route where candidate hotspot set includes at least one priority 2 and one priority 5 hotspot.
2. Trigger itinerary rebuild/optimization for that route.
3. Expected:
- Priority 2 hotspot is selected/scheduled before priority 5 when both are feasible.

### Test 17: Equal priority resolves by nearest distance
1. Use two candidate hotspots with the same priority and valid timing windows.
2. Ensure one is measurably closer to current route coordinates than the other.
3. Trigger optimization.
4. Expected:
- The nearer hotspot is selected/scheduled first.

### Test 18: City order does not override priority
1. Use a scenario where a higher-priority hotspot belongs to a later city-order bucket and a lower-priority hotspot belongs to an earlier city-order bucket.
2. Trigger optimization.
3. Expected:
- Higher-priority hotspot is selected before lower-priority hotspot.
- City order only acts as a tie-breaker and does not override priority.

## Step 5 Manual Tests: Two-Stage Optimization Flow

Scope: Validate active builder pipeline uses explicit two-stage ordering: first priority 1/2/3 hotspots, then nearest-distance chaining for the rest.

### Test 19: Top 1/2/3 are selected before lower priorities
1. Use a route with mixed priorities including 1, 2, 3, 4, 5 and optional (0).
2. Trigger rebuild/optimization.
3. Expected:
- Priority 1/2/3 hotspots appear before priority 4+ hotspots in selected candidate order.

### Test 20: Remaining hotspots follow nearest-distance chaining
1. After confirming top-priority hotspots are placed first, inspect order of remaining hotspots.
2. Use known coordinates or route distance evidence from logs/debug output.
3. Expected:
- After Stage A hotspots, remaining hotspots are ordered by nearest next candidate from last selected point.

### Test 21: Direct route behavior remains correct
1. Use a route with direct_to_next_visiting_place = 1.
2. Trigger rebuild/optimization.
3. Expected:
- Direct routing candidate set behavior remains correct (via/destination handling unchanged).
- Two-stage ordering applies within the active candidate list without breaking direct flow.

### Test 22: Via route behavior remains correct
1. Use a route containing via locations.
2. Trigger rebuild/optimization.
3. Expected:
- Via candidate inclusion still works.
- Two-stage ordering applies without dropping valid via candidates.

### Test 23: Deterministic rebuild for same inputs
1. Run rebuild twice with unchanged itinerary inputs.
2. Compare selected hotspot order and timeline output.
3. Expected:
- Candidate ordering and resulting timeline are deterministic for identical inputs.

## Step 6 Manual Tests: Activity-Aware Rerouting And Conflict Handling

Scope: Validate activity addition uses pre-insert simulation, removes optional hotspots first when needed, warns on priority shifts, and rejects impossible conflicts.

### Test 24: Activity removes optional hotspots first
1. Use a route where an activity extension causes end-of-day overflow and route has optional downstream hotspots.
2. Add activity to a mid-route hotspot.
3. Expected:
- API success response includes warning message "optional hotspots removed".
- Optional downstream hotspots are removed/deactivated from that route timeline.
- Activity is added successfully.

### Test 25: Activity shifts schedule with priority warning
1. Use a route where extension shifts downstream priority hotspots but still fits day end.
2. Add activity with enough duration to shift downstream timings.
3. Expected:
- API success response includes warning message "priority hotspot shifted".
- Activity is added.
- Downstream timings are shifted consistently with no duplicate rows.

### Test 26: Activity conflicts with priority hotspot
1. Use a route where activity extension would force priority 1/2/3 overflow after optional removals.
2. Add activity on the target hotspot.
3. Expected:
- API returns validation failure.
- Response warning includes "activity cannot be added without conflict".
- No new activity row is persisted.

### Test 27: Activity rejected when impossible
1. Pick a near-end hotspot and add a long activity that clearly exceeds route end with only priority hotspots remaining.
2. Submit add activity request.
3. Expected:
- Request is rejected.
- No silent success message.
- No duplicate rows and no partial activity insert.

### Test 28: Reroute simulation correctness and delete rebuild safety
1. Add an activity that triggers warnings (optional removed or priority shifted).
2. Verify warning payload shape is structured (type/message/details).
3. Delete that activity.
4. Expected:
- Delete still triggers full rebuild and succeeds.
- Timeline remains consistent after delete.
- No duplicate hotspot/activity rows created.

## Step 7 Manual Tests: Morning/Evening Time-Slot Intelligence

Scope: Validate MORNING/EVENING slot-aware deferral for hotspots, preserving priority behavior and deterministic chaining.

### Test 29: Hotspot moves from morning to evening slot
1. Use a route where a hotspot travel + visit crosses noon when attempted in MORNING.
2. Trigger rebuild.
3. Expected:
- Hotspot is deferred to EVENING slot instead of being scheduled across slot boundary.
- Timeline remains ordered and valid.

### Test 30: Deferred hotspot placed in next valid slot
1. Use a hotspot that opens later in the day than current visit time.
2. Trigger rebuild.
3. Expected:
- Hotspot is deferred and then placed when next valid slot/window starts.
- No duplicate hotspot rows for the same hotspot.

### Test 31: Priority hotspot is not dropped when defer is possible
1. Use a priority hotspot (1/2/3) that cannot fit current slot but has a later valid slot.
2. Trigger rebuild.
3. Expected:
- Priority hotspot is deferred and retried.
- It is not dropped while defer remains possible.

### Test 32: Optional hotspot dropped if no valid slot
1. Use an optional hotspot with no valid same-day slot/window.
2. Trigger rebuild.
3. Expected:
- Optional hotspot is skipped.
- Priority hotspots continue to be considered.

### Test 33: Chaining resumes after deferred placement
1. Use multiple hotspots where one is deferred due to slot/window.
2. Trigger rebuild and inspect final order.
3. Expected:
- After deferred hotspot placement, nearest chaining continues deterministically for remaining hotspots.
- Re-running rebuild with same inputs produces same order.

## Step 9 Manual Tests: Multi-Day Carry-Forward

Scope: Validate unscheduled hotspots from day N are carried to day N+1 deterministically, with priority hotspots processed before optional hotspots.

### Test 34: Missed priority hotspot carries to next day
1. Use a multi-day itinerary where a priority 1/2/3 hotspot cannot be scheduled on day N due to time constraints.
2. Trigger rebuild.
3. Expected:
- Missed priority hotspot appears in day N+1 candidate scheduling path.
- Hotspot is considered before optional carry-forward hotspots.

### Test 35: Optional hotspot carries only after priority hotspots
1. Use day N with both missed priority and missed optional hotspots.
2. Trigger rebuild.
3. Expected:
- Day N+1 carry-forward order evaluates priority hotspots first.
- Optional carry-forward hotspots are evaluated after priority carry-forward hotspots.

### Test 36: No duplicate hotspot rows across days
1. Trigger rebuild for itinerary with carry-forward events.
2. Run DB check:
```sql
SELECT itinerary_plan_ID, hotspot_ID, COUNT(*) AS cnt
FROM dvi_itinerary_route_hotspot_details
WHERE itinerary_plan_ID = <planId>
  AND item_type = 4
  AND deleted = 0
GROUP BY itinerary_plan_ID, hotspot_ID
HAVING COUNT(*) > 1;
```
3. Expected:
- No duplicate active hotspot rows for same hotspot_ID across rebuilt plan.

### Test 37: Deterministic rebuild with carry-forward
1. Rebuild same itinerary twice with unchanged inputs.
2. Compare day-wise hotspot order and carry-forward outcomes.
3. Expected:
- Same hotspots carry to same next day route.
- Same processing order across repeated rebuilds.

### Test 38: Activity/delete/rebuild still works after carry-forward
1. Add activity on a route that also has carry-forwarded hotspots.
2. Delete that activity.
3. Trigger/verify rebuild.
4. Expected:
- Activity add/delete behavior remains correct.
- Carry-forward behavior still applies after rebuild.
- No duplicate rows introduced.

## Step 8 Manual Tests: Direct/Via Parity And Rebuild Triggers

Scope: Validate direct destination and via-route behavior stays consistent across create flow, persistence, and rebuild/edit interactions.

### Test 39: Direct destination create to rebuild parity
1. In create itinerary, mark one route as direct destination visit = Yes.
2. Save itinerary and trigger rebuild.
3. Expected:
- Route persists with direct_to_next_visiting_place = 1.
- Source sightseeing for that route is skipped consistently.
- Rebuild output matches direct behavior.

### Test 40: Via-route create to rebuild parity
1. Add via routes for a segment in create flow and save.
2. Trigger rebuild from itinerary details.
3. Expected:
- Via-route records persist and are associated to the correct route.
- Rebuild keeps via-route candidate inclusion/timing behavior.

### Test 41: Direct route toggle behavior in create flow
1. Toggle direct destination visit from No -> Yes -> No on same row.
2. Save and re-open itinerary for edit.
3. Expected:
- Toggle state changes both directions correctly.
- Saved value matches backend flag exactly.

### Test 42: Via-route timing still affects itinerary after rebuild
1. Configure a route with via points expected to influence travel segments.
2. Rebuild itinerary.
3. Expected:
- Timeline/travel segments still reflect via-route impact.
- No drift between initial generation and rebuild output.

### Test 43: User edits trigger rebuild where expected
1. Perform edits that affect routing (e.g., route time update, hotspot delete, activity delete).
2. Observe itinerary refresh after each edit.
3. Expected:
- Backend rebuild runs where required.
- UI reflects updated itinerary without requiring stale/manual rebuild prompt for delete-hotspot flow.

## Step 10 Manual Tests: Reusable Template Persistence

Scope: Validate itinerary templates are persisted and reused by source/destination/day-count match without changing planner behavior.

### Test 44: Template auto-saves on create/update
1. Create or update an itinerary with clear route and vehicle customization.
2. Verify DB row insertion:
```sql
SELECT template_id, source_location, destination_location, day_count, created_from_plan_id
FROM dvi_itinerary_reusable_templates
WHERE created_from_plan_id = <planId>
ORDER BY template_id DESC
LIMIT 1;
```
3. Expected:
- One latest template row exists for the saved plan.
- `source_location`, `destination_location`, and `day_count` match the itinerary.

### Test 45: Template payload contains routes/hotspots/manual/activity
1. For the inserted template row, inspect payload JSON:
```sql
SELECT template_payload
FROM dvi_itinerary_reusable_templates
WHERE template_id = <templateId>;
```
2. Expected:
- JSON includes keys: `plan`, `routes`, `vehicles`, `hotspots`, `manual_hotspots`, `activities`.
- Manual hotspot subset appears under `manual_hotspots` when present.

### Test 46: Match endpoint returns latest template
1. Call:
`GET /itineraries/templates/match?sourceLocation=<src>&destinationLocation=<dst>&dayCount=<n>`
2. Expected:
- Response has `found: true` when matching templates exist.
- Response includes `template`, `metadata`, and the latest `templateId` for the same criteria.

### Test 47: Create page preloads matching template
1. Open create itinerary page (no `id` edit param).
2. Select same arrival, departure, and trip dates that produce matching day count.
3. Expected:
- Form preloads metadata fields from template (type/preference/options).
- Route rows and vehicle rows are prefilled from template.
- Toast indicates template was loaded.

### Test 48: No match does not override user input
1. Use source/destination/day-count combination with no saved template.
2. Fill form fields manually.
3. Expected:
- No template overwrite occurs.
- User-entered values remain intact.

### Test 49: Planner behavior unchanged with loaded template
1. Load template in create flow and save itinerary.
2. Trigger rebuild and activity/manual hotspot operations as usual.
3. Expected:
- Existing planner behavior from Steps 5/6/7/9 remains unchanged.
- Save/load template path does not introduce rebuild regressions.

### Test 50: DVI202604218 Day 1 priority regression (Gandhi before Keeladi)
1. Use quote `DVI202604218` and trigger Day 1 rebuild path (`POST /itineraries/{planId}/route/{day1RouteId}/rebuild`).
2. Fetch itinerary details:
  `GET /itineraries/details/DVI202604218`
3. In Day 1 attractions order, locate:
  - `Gandhi Museum` (priority 3)
  - `Keeladi museum` (priority 8)
4. Expected:
- `Gandhi Museum` appears before `Keeladi museum` when both are feasible in same-day window.
- If `Gandhi Museum` cannot fit due real timing constraints, it may be deferred, but it must not be demoted by same-pass 4+ fillers while still feasible.
