
## DVI20260798 - Latest Verified Live Rebuild

- Quote ID: `DVI20260798`
- Plan ID: `9871`
- Verified on: `2026-07-12`
- Verification source: live `type=itineary_basic_info` rebuild, followed by DB row check, details API check, and browser check on `http://localhost:8080/itinerary-details/DVI20260798`

### Verified Outcome Summary

- This quote is now in the fixed state for the original same-city cross-day issue.
- `Macca Masjid` no longer stays on Day 1.
- `Macca Masjid` now moves to Day 2.
- `Macca Masjid` keeps its inbound travel leg.
- The old overlap with `Lumbini Park` is gone.
- The current verified adjacency is `Macca Masjid -> Charminar`, not `Charminar -> Macca Masjid`.

### Current Verified Route IDs

- Day 1 route: `8724`
- Day 2 route: `8725`
- Day 3 route: `8726`

### Current Verified Day Counts

- Day 1 selected hotspots: `1`
- Day 2 selected hotspots: `7`
- Day 3 selected hotspots: `0`

### Current Verified Day 1

- Persisted sightseeing:
1. `Ramoji Film City`

- Verified Day 1 timeline shape:
1. Start: `08:00 AM -> 09:00 AM`
2. Travel: `Hyderabad, Rajiv Gandhi International Airport -> Ramoji Film City` | `09:00 AM -> 10:01 AM`
3. Visit: `Ramoji Film City` | `10:01 AM -> 05:01 PM`
4. Travel: `Ramoji Film City -> Hotel` | `06:20 PM -> 08:00 PM`
5. Check-in: `08:00 PM`

### Current Verified Day 2

- Persisted sightseeing in current verified order:
1. `Macca Masjid`
2. `Charminar`
3. `Qutub Shahi Tombs`
4. `Sudha car museum hyd`
5. `Birla Mandir`
6. `Lumbini Park`
7. `NTR Gardens`

- Verified Day 2 timeline shape:
1. Start: `08:00 AM -> 09:00 AM`
2. Travel: `Hotel -> Macca Masjid` | `09:00 AM -> 09:30 AM` | `7.57 KM`
3. Visit: `Macca Masjid` | `09:30 AM -> 09:50 AM`
4. Travel: `Macca Masjid -> Charminar` | `09:50 AM -> 09:55 AM` | `0.08 KM`
5. Visit: `Charminar` | `09:55 AM -> 10:55 AM`
6. Travel: `Charminar -> Qutub Shahi Tombs` | `10:55 AM -> 11:15 AM`
7. Visit: `Qutub Shahi Tombs` | `11:15 AM -> 12:15 PM`
8. Travel: `Qutub Shahi Tombs -> Sudha car museum hyd` | `12:15 PM -> 01:09 PM`
9. Visit: `Sudha car museum hyd` | `01:09 PM -> 02:09 PM`
10. Travel: `Sudha car museum hyd -> Birla Mandir` | `02:09 PM -> 02:58 PM`
11. Visit: `Birla Mandir` | `02:58 PM -> 04:28 PM`
12. Travel: `Birla Mandir -> Lumbini Park` | `04:28 PM -> 04:33 PM`
13. Visit: `Lumbini Park` | `04:33 PM -> 05:33 PM`
14. Travel: `Lumbini Park -> NTR Gardens` | `05:33 PM -> 05:38 PM`
15. Visit: `NTR Gardens` | `05:38 PM -> 06:38 PM`
16. Travel: `NTR Gardens -> Hotel` | `06:38 PM -> 07:43 PM`
17. Check-in: `07:43 PM`

### What Is Fixed

- `Macca Masjid` is no longer orphaned from its inbound travel row.
- `Macca Masjid` no longer overlaps `Lumbini Park`.
- The same-city pair now survives as a consecutive local hop on Day 2.
- The browser page, details API, and persisted DB rows all agree on the new sequence.

### Important Documentation Note

- Older `DVI20260798` blocks later in this file are still useful as historical debugging snapshots.
- If an older block disagrees with this section, treat this section as the latest verified live state.

## DVI20260798

- Quote ID: `DVI20260798`
- Plan ID: `9871`
- Generated: 2026-07-11T15:05:00.755Z
- Snapshot source: current persisted DB state at generation time
- Scope: all days

### Plan Summary

- Arrival: Hyderabad, Rajiv Gandhi International Airport
- Departure: Hyderabad, Rajiv Gandhi International Airport
- Trip window: 2026-07-12 08:00 AM -> 2026-07-14 01:00 PM
- Days / nights: 3 days, 2 nights
- Arrival type: 1
- Departure type: 1

### Plain-English Overview

- For quote `DVI20260798`, the engine builds each day by first finding source / via / destination hotspot candidates, then ordering them by priority, and finally keeping only the ones that fit the day's timing window.
- Selected hotspots by day: Day 1=2, Day 2=6, Day 3=0.
- The last day is intentionally transfer-only because the airport-report cutoff is 12 PM or earlier, so sightseeing is suppressed before the return leg is built.

### Global Rules Used In This Analysis

- Auto hotspot ranking uses lower numeric `hotspot_priority` first; `0` is treated as lowest/optional.
- `direct_to_next_visiting_place = 0` means the route can pull from source + via + destination buckets, with source auto hotspots limited to top 3.
- Manual hotspots would stay in the pool as effective priority `4`, but this quote currently has no manual hotspot rows.
- Last-route airport logic suppresses sightseeing when the final route ends at or before `12:00 PM`.
- Persisted attraction rows (`item_type = 4`) are treated as the final selected hotspots for the day.
- Candidate-pool ranking explains why a hotspot was eligible; the persisted order is the final source of truth for what actually survived schedule fit.

### Cross-Day Optimizer Notes

- The notes below come from the production `SameCityCrossDayOptimizerService` dry-run output, not a local approximation.
- Optimizer enabled: yes
- Dry-run default: yes
- Applied: no
- Skip reason: dry-run mode is enabled; no database changes were made

Route snapshots from production optimizer:
- Route 8633 | Day 1 | cityKey=hyderabad telangana india | transferOnly=no | auto=2 | manual=0 | total=2
- Route 8634 | Day 2 | cityKey=hyderabad telangana india | transferOnly=no | auto=6 | manual=0 | total=6
- Route 8635 | Day 3 | cityKey=hyderabad telangana india | transferOnly=yes | auto=0 | manual=0 | total=0

Proposed cross-day move opportunities:
- Move Macca Masjid from route 8633 to route 8634 beside Charminar | raw priority 0 | score 39122 | distance 0.05 km
- Why: cluster cluster-1 with 2 movable hotspot(s); move Macca Masjid beside movable companion Charminar; distance=0.05km; target route cluster count=1
- Cluster members: Macca Masjid, Charminar

Allocation plan from production optimizer:
- City group: hyderabad telangana india|hyderabad telangana india|hyderabad telangana india
- Route 8633 fixed anchors: 194(priority hotspot pinned on route 8633)
- Route 8634 fixed anchors: 846(priority hotspot pinned on route 8634)
- Route 8635 fixed anchors: none
- Route 8633 desired movable hotspot IDs: none
- Route 8634 desired movable hotspot IDs: 162, 170, 373, 166, 191, 172
- Route 8635 desired movable hotspot IDs: none
- Route 8633 desired movable order: none
- Route 8634 desired movable order: 162, 170, 373, 166, 191, 172
- Route 8635 desired movable order: none
- Route 8634 preferred adjacency pairs: 162-172
- Unallocated hotspot IDs: none

Cluster summaries:
- cluster-1: members=Macca Masjid, Charminar | routes=8633, 8634 | maxPair=0.05 km | totalVisit=80m
- Macca Masjid <-> Charminar: 0.05 km
- cluster-2: members=Birla Mandir, Lumbini Park | routes=8634 | maxPair=0.32 km | totalVisit=150m
- Birla Mandir <-> Lumbini Park: 0.32 km
- cluster-3: members=Qutub Shahi Tombs | routes=8634 | maxPair=0.00 km | totalVisit=60m
- cluster-4: members=Sudha car museum hyd | routes=8634 | maxPair=0.00 km | totalVisit=60m

Current movable pool gaps:
- Macca Masjid on route 8633 | hotspot 172 | priority 0 | visit 20m
- Charminar on route 8634 | hotspot 162 | priority 0 | visit 60m
- Qutub Shahi Tombs on route 8634 | hotspot 170 | priority 0 | visit 60m
- Sudha car museum hyd on route 8634 | hotspot 373 | priority 0 | visit 60m
- Birla Mandir on route 8634 | hotspot 166 | priority 0 | visit 90m
- Lumbini Park on route 8634 | hotspot 191 | priority 0 | visit 60m

### Day 1

- Route ID: `8633`
- Date: 2026-07-12
- Source: Hyderabad, Rajiv Gandhi International Airport
- Destination: Hyderabad, Telangana, India
- Route window: 08:00 AM -> 08:00 PM
- Via locations: none
- Distance on route row: 34.80

Human-readable selection story:
- This is the arrival day, so the engine starts from the arrival point (Hyderabad, Rajiv Gandhi International Airport) and tries to use the available post-arrival hours before the day ends.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- Ramoji Film City becomes the first persisted hotspot, which means it is the first candidate that both matched the route buckets and survived the actual schedule-fit checks.
- After the first hotspot is fixed, the rest of the day is filled by whatever can still fit in the remaining time window without breaking route-end constraints.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots
- first route: Day-1 fallback helper can prioritize source-city hotspots by `priority ASC` then `distance ASC`

Candidate pool snapshot:
- Source matches: 26 total, top-3 used for non-direct source bucket
- Destination matches: 26
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 26

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.7 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 28.7 km from source
3. Calvary Temple | priority 15 | 42.3 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.7 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 28.7 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 42.3 km from route source
4. Sudha car museum hyd | raw priority 0 | effective priority 9999 | buckets: source, destination | 16.2 km from route source
5. Taj Falaknuma Palace, Hyderabad | raw priority 0 | effective priority 9999 | buckets: source, destination | 16.4 km from route source
6. Statue Of Equality | raw priority 0 | effective priority 9999 | buckets: source, destination | 17.8 km from route source
7. Nehru Zoological Park Hyderabad | raw priority 0 | effective priority 9999 | buckets: source, destination | 18.9 km from route source
8. Chowmahalla Palace | raw priority 0 | effective priority 9999 | buckets: source, destination | 20.9 km from route source

Selected hotspots in persisted order:
1. Ramoji Film City
   Travel into hotspot: 09:00 AM -> 10:01 AM
   Visit window: 10:01 AM -> 05:01 PM (7h)
   Persisted route hotspot row: `132064`
   Why selected: master priority is 1, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early
   Why selected: persisted travel leg reaches it at 10:01 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 06:00 PM
2. Macca Masjid
   Travel into hotspot: 05:01 PM -> 05:56 PM
   Visit window: 05:56 PM -> 06:16 PM (20m)
   Persisted route hotspot row: `132076`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early
   Why selected: persisted travel leg reaches it at 05:56 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 04:00 AM -> 08:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone

Notable eligible but unpersisted candidates:
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Macca Masjid because its priority is 10 while the selected day was already filled by priority 0 items
- Calvary Temple | raw priority 15 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Macca Masjid because its priority is 15 while the selected day was already filled by priority 0 items
- Sudha car museum hyd | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Macca Masjid, so the final choice came down to schedule-fit tie-breaking rather than priority
- Taj Falaknuma Palace, Hyderabad | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Macca Masjid, so the final choice came down to schedule-fit tie-breaking rather than priority
- Statue Of Equality | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Macca Masjid, so the final choice came down to schedule-fit tie-breaking rather than priority

### Day 2

- Route ID: `8634`
- Date: 2026-07-13
- Source: Hyderabad, Telangana, India
- Destination: Hyderabad, Telangana, India
- Route window: 08:00 AM -> 08:00 PM
- Via locations: none
- Distance on route row: 1.00

Human-readable selection story:
- This day starts in Hyderabad, Telangana, India and ends in Hyderabad, Telangana, India, so the engine treats it as a same-city route for hotspot selection.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- Calvary Temple becomes the first persisted hotspot, which means it is the first candidate that both matched the route buckets and survived the actual schedule-fit checks.
- Even though Ramoji Film City, Sri Chilkur Balaji Temple had a stronger priority ranking, they were not persisted before Calvary Temple, so they likely failed later timing/fit checks for this day's route shape.
- After the first hotspot is fixed, the rest of the day is filled by whatever can still fit in the remaining time window without breaking route-end constraints.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots

Candidate pool snapshot:
- Source matches: 26 total, top-3 used for non-direct source bucket
- Destination matches: 26
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 26

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.4 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 29.5 km from source
3. Calvary Temple | priority 15 | 21.9 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.4 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 29.5 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 21.9 km from route source
4. B.M. Birla Science Museum | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.3 km from route source
5. Birla Mandir | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.9 km from route source
6. Lumbini Park | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.0 km from route source
7. Snow World | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.5 km from route source
8. NTR Gardens | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.6 km from route source

Selected hotspots in persisted order:
1. Calvary Temple
   Travel into hotspot: 09:00 AM -> 09:33 AM
   Visit window: 09:33 AM -> 10:33 AM (1h)
   Persisted route hotspot row: `132063`
   Why selected: master priority is 15, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 09:33 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 07:00 PM
2. Charminar
   Travel into hotspot: 10:33 AM -> 11:13 AM
   Visit window: 11:13 AM -> 12:13 PM (1h)
   Persisted route hotspot row: `132066`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 11:13 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
3. Qutub Shahi Tombs
   Travel into hotspot: 12:13 PM -> 12:33 PM
   Visit window: 12:33 PM -> 01:33 PM (1h)
   Persisted route hotspot row: `132068`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 12:33 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
4. Sudha car museum hyd
   Travel into hotspot: 01:33 PM -> 02:27 PM
   Visit window: 02:27 PM -> 03:27 PM (1h)
   Persisted route hotspot row: `132070`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 02:27 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 06:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
5. Birla Mandir
   Travel into hotspot: 03:27 PM -> 04:16 PM
   Visit window: 04:16 PM -> 05:46 PM (1h 30m)
   Persisted route hotspot row: `132072`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 04:16 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 07:00 AM -> 12:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
6. Lumbini Park
   Travel into hotspot: 05:46 PM -> 05:51 PM
   Visit window: 05:51 PM -> 06:51 PM (1h)
   Persisted route hotspot row: `132075`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 05:51 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 05:00 AM -> 08:00 AM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone

Notable eligible but unpersisted candidates:
- Ramoji Film City | raw priority 1 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Charminar, Qutub Shahi Tombs, Sudha car museum hyd because its priority is 1 while the selected day was already filled by priority 0 items
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Charminar, Qutub Shahi Tombs, Sudha car museum hyd because its priority is 10 while the selected day was already filled by priority 0 items
- B.M. Birla Science Museum | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Qutub Shahi Tombs, Sudha car museum hyd, so the final choice came down to schedule-fit tie-breaking rather than priority
- Snow World | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Qutub Shahi Tombs, Sudha car museum hyd, so the final choice came down to schedule-fit tie-breaking rather than priority
- NTR Gardens | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Qutub Shahi Tombs, Sudha car museum hyd, so the final choice came down to schedule-fit tie-breaking rather than priority

### Day 3

- Route ID: `8635`
- Date: 2026-07-14
- Source: Hyderabad, Telangana, India
- Destination: Hyderabad, Rajiv Gandhi International Airport
- Route window: 08:00 AM -> 11:00 AM
- Via locations: none
- Distance on route row: 34.80

Human-readable selection story:
- This day starts in Hyderabad, Telangana, India and ends in Hyderabad, Rajiv Gandhi International Airport, so the engine treats it as a same-city route for hotspot selection.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- No sightseeing survives on this day because the last-day airport cutoff converts the route into a transfer-only morning.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots
- last route ends at or before 12 PM: current airport rule makes this a transfer-only route with no sightseeing

Candidate pool snapshot:
- Source matches: 26 total, top-3 used for non-direct source bucket
- Destination matches: 26
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 26

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.4 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 29.5 km from source
3. Calvary Temple | priority 15 | 21.9 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.4 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 29.5 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 21.9 km from route source
4. B.M. Birla Science Museum | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.3 km from route source
5. Birla Mandir | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.9 km from route source
6. Lumbini Park | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.0 km from route source
7. Snow World | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.5 km from route source
8. NTR Gardens | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.6 km from route source

Selected hotspots:
- None

Why no hotspot was selected:
- This is the last airport-return route and its end time is `12:00 PM` or earlier, so the current rule makes it transfer-only.
- The persisted route only contains an `item_type = 7` airport transfer row, which means sightseeing rows were intentionally skipped.
- Even though candidates such as Ramoji Film City, Sri Chilkur Balaji Temple, Calvary Temple are eligible in the generic pool, the transfer-only rule stops them from being persisted on this last day.

## DVI20260798

- Quote ID: `DVI20260798`
- Plan ID: `9871`
- Generated: 2026-07-11T17:37:06.762Z
- Snapshot source: current persisted DB state at generation time
- Scope: all days

### Plan Summary

- Arrival: Hyderabad, Rajiv Gandhi International Airport
- Departure: Hyderabad, Rajiv Gandhi International Airport
- Trip window: 2026-07-12 08:00 AM -> 2026-07-14 01:00 PM
- Days / nights: 3 days, 2 nights
- Arrival type: 1
- Departure type: 1

### Plain-English Overview

- For quote `DVI20260798`, the engine builds each day by first finding source / via / destination hotspot candidates, then ordering them by priority, and finally keeping only the ones that fit the day's timing window.
- Selected hotspots by day: Day 1=1, Day 2=7, Day 3=0.
- The last day is intentionally transfer-only because the airport-report cutoff is 12 PM or earlier, so sightseeing is suppressed before the return leg is built.

### Global Rules Used In This Analysis

- Auto hotspot ranking uses lower numeric `hotspot_priority` first; `0` is treated as lowest/optional.
- `direct_to_next_visiting_place = 0` means the route can pull from source + via + destination buckets, with source auto hotspots limited to top 3.
- Manual hotspots would stay in the pool as effective priority `4`, but this quote currently has no manual hotspot rows.
- Last-route airport logic suppresses sightseeing when the final route ends at or before `12:00 PM`.
- Persisted attraction rows (`item_type = 4`) are treated as the final selected hotspots for the day.
- Candidate-pool ranking explains why a hotspot was eligible; the persisted order is the final source of truth for what actually survived schedule fit.

### Cross-Day Optimizer Notes

- The notes below come from the production `SameCityCrossDayOptimizerService` dry-run output, not a local approximation.

- Optimizer enabled: yes
- Dry-run default: yes
- Applied: no
- Skip reason: dry-run mode is enabled; no database changes were made

Route snapshots from production optimizer:
- Route 8692 | Day 1 | cityKey=hyderabad telangana india | transferOnly=no | auto=1 | manual=0 | total=1
- Route 8693 | Day 2 | cityKey=hyderabad telangana india | transferOnly=no | auto=7 | manual=0 | total=7
- Route 8694 | Day 3 | cityKey=hyderabad telangana india | transferOnly=yes | auto=0 | manual=0 | total=0

- No safe cross-day redistribution was proposed for this quote.
- Either the same-city chain is already balanced, the target day is protected, or no bounded hotspot cluster met the production optimizer rules.

### Day 1

- Route ID: `8692`
- Date: 2026-07-12
- Source: Hyderabad, Rajiv Gandhi International Airport
- Destination: Hyderabad, Telangana, India
- Route window: 08:00 AM -> 08:00 PM
- Via locations: none
- Distance on route row: 34.80

Human-readable selection story:
- This is the arrival day, so the engine starts from the arrival point (Hyderabad, Rajiv Gandhi International Airport) and tries to use the available post-arrival hours before the day ends.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- Ramoji Film City becomes the first persisted hotspot, which means it is the first candidate that both matched the route buckets and survived the actual schedule-fit checks.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots
- first route: Day-1 fallback helper can prioritize source-city hotspots by `priority ASC` then `distance ASC`

Candidate pool snapshot:
- Source matches: 25 total, top-3 used for non-direct source bucket
- Destination matches: 25
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 25

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.7 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 28.7 km from source
3. Calvary Temple | priority 15 | 42.3 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.7 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 28.7 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 42.3 km from route source
4. Sudha car museum hyd | raw priority 0 | effective priority 9999 | buckets: source, destination | 16.2 km from route source
5. Taj Falaknuma Palace, Hyderabad | raw priority 0 | effective priority 9999 | buckets: source, destination | 16.4 km from route source
6. Statue Of Equality | raw priority 0 | effective priority 9999 | buckets: source, destination | 17.8 km from route source
7. Nehru Zoological Park Hyderabad | raw priority 0 | effective priority 9999 | buckets: source, destination | 18.9 km from route source
8. Chowmahalla Palace | raw priority 0 | effective priority 9999 | buckets: source, destination | 20.9 km from route source

Selected hotspots in persisted order:
1. Ramoji Film City
   Travel into hotspot: 09:00 AM -> 10:01 AM
   Visit window: 10:01 AM -> 05:01 PM (7h)
   Persisted route hotspot row: `132914`
   Why selected: master priority is 1, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early
   Why selected: persisted travel leg reaches it at 10:01 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 06:00 PM

Notable eligible but unpersisted candidates:
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Ramoji Film City because its priority is 10 while the selected day was already filled by priority 1 items
- Calvary Temple | raw priority 15 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Ramoji Film City because its priority is 15 while the selected day was already filled by priority 1 items
- Sudha car museum hyd | raw priority 0 | buckets: source, destination | reason: remained eligible, but its source distance (16.2 km) was farther than the persisted chain that fit the day
- Taj Falaknuma Palace, Hyderabad | raw priority 0 | buckets: source, destination | reason: remained eligible, but its source distance (16.4 km) was farther than the persisted chain that fit the day
- Statue Of Equality | raw priority 0 | buckets: source, destination | reason: remained eligible, but its source distance (17.8 km) was farther than the persisted chain that fit the day

### Day 2

- Route ID: `8693`
- Date: 2026-07-13
- Source: Hyderabad, Telangana, India
- Destination: Hyderabad, Telangana, India
- Route window: 08:00 AM -> 08:00 PM
- Via locations: none
- Distance on route row: 1.00

Human-readable selection story:
- This day starts in Hyderabad, Telangana, India and ends in Hyderabad, Telangana, India, so the engine treats it as a same-city route for hotspot selection.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- Calvary Temple becomes the first persisted hotspot, which means it is the first candidate that both matched the route buckets and survived the actual schedule-fit checks.
- Even though Ramoji Film City, Sri Chilkur Balaji Temple had a stronger priority ranking, they were not persisted before Calvary Temple, so they likely failed later timing/fit checks for this day's route shape.
- After the first hotspot is fixed, the rest of the day is filled by whatever can still fit in the remaining time window without breaking route-end constraints.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots

Candidate pool snapshot:
- Source matches: 26 total, top-3 used for non-direct source bucket
- Destination matches: 26
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 26

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.4 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 29.5 km from source
3. Calvary Temple | priority 15 | 21.9 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.4 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 29.5 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 21.9 km from route source
4. B.M. Birla Science Museum | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.3 km from route source
5. Birla Mandir | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.9 km from route source
6. Lumbini Park | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.0 km from route source
7. Snow World | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.5 km from route source
8. NTR Gardens | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.6 km from route source

Selected hotspots in persisted order:
1. Calvary Temple
   Travel into hotspot: 09:00 AM -> 09:33 AM
   Visit window: 09:33 AM -> 10:33 AM (1h)
   Persisted route hotspot row: `132913`
   Why selected: master priority is 15, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 09:33 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 07:00 PM
2. Charminar
   Travel into hotspot: 10:33 AM -> 11:13 AM
   Visit window: 11:13 AM -> 12:13 PM (1h)
   Persisted route hotspot row: `132916`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 11:13 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
3. Macca Masjid
   Travel into hotspot: not found
   Visit window: 05:56 PM -> 06:16 PM (20m)
   Persisted route hotspot row: `132929`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: operating-hours evidence for route day: 04:00 AM -> 08:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
4. Qutub Shahi Tombs
   Travel into hotspot: 12:13 PM -> 12:33 PM
   Visit window: 12:33 PM -> 01:33 PM (1h)
   Persisted route hotspot row: `132918`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 12:33 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
5. Sudha car museum hyd
   Travel into hotspot: 01:33 PM -> 02:27 PM
   Visit window: 02:27 PM -> 03:27 PM (1h)
   Persisted route hotspot row: `132920`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 02:27 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 06:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
6. Birla Mandir
   Travel into hotspot: 03:27 PM -> 04:16 PM
   Visit window: 04:16 PM -> 05:46 PM (1h 30m)
   Persisted route hotspot row: `132922`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 04:16 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 07:00 AM -> 12:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
7. Lumbini Park
   Travel into hotspot: 05:46 PM -> 05:51 PM
   Visit window: 05:51 PM -> 06:51 PM (1h)
   Persisted route hotspot row: `132924`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 05:51 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 05:00 AM -> 08:00 AM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone

Notable eligible but unpersisted candidates:
- Ramoji Film City | raw priority 1 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Charminar, Macca Masjid, Qutub Shahi Tombs because its priority is 1 while the selected day was already filled by priority 0 items
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | reason: ranked below the persisted hotspot(s) Charminar, Macca Masjid, Qutub Shahi Tombs because its priority is 10 while the selected day was already filled by priority 0 items
- B.M. Birla Science Museum | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Macca Masjid, Qutub Shahi Tombs, so the final choice came down to schedule-fit tie-breaking rather than priority
- Snow World | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Macca Masjid, Qutub Shahi Tombs, so the final choice came down to schedule-fit tie-breaking rather than priority
- NTR Gardens | raw priority 0 | buckets: source, destination | reason: tied on priority with persisted hotspot(s) Charminar, Macca Masjid, Qutub Shahi Tombs, so the final choice came down to schedule-fit tie-breaking rather than priority

### Day 3

- Route ID: `8694`
- Date: 2026-07-14
- Source: Hyderabad, Telangana, India
- Destination: Hyderabad, Rajiv Gandhi International Airport
- Route window: 08:00 AM -> 11:00 AM
- Via locations: none
- Distance on route row: 34.80

Human-readable selection story:
- This day starts in Hyderabad, Telangana, India and ends in Hyderabad, Rajiv Gandhi International Airport, so the engine treats it as a same-city route for hotspot selection.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- No sightseeing survives on this day because the last-day airport cutoff converts the route into a transfer-only morning.

Route-rule summary:
- direct_to_next_visiting_place = 0
- non-direct route: auto pool uses top-3 source hotspots + via hotspots + destination hotspots + manual hotspots
- last route ends at or before 12 PM: current airport rule makes this a transfer-only route with no sightseeing

Candidate pool snapshot:
- Source matches: 26 total, top-3 used for non-direct source bucket
- Destination matches: 26
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 26

Top source-side candidates that the engine is most willing to try first:
1. Ramoji Film City | priority 1 | 40.4 km from source
2. Sri Chilkur Balaji Temple | priority 10 | 29.5 km from source
3. Calvary Temple | priority 15 | 21.9 km from source

Top merged candidates before timing fit:
1. Ramoji Film City | raw priority 1 | effective priority 1 | buckets: source, destination | 40.4 km from route source
2. Sri Chilkur Balaji Temple | raw priority 10 | effective priority 10 | buckets: source, destination | 29.5 km from route source
3. Calvary Temple | raw priority 15 | effective priority 15 | buckets: source, destination | 21.9 km from route source
4. B.M. Birla Science Museum | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.3 km from route source
5. Birla Mandir | raw priority 0 | effective priority 9999 | buckets: source, destination | 0.9 km from route source
6. Lumbini Park | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.0 km from route source
7. Snow World | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.5 km from route source
8. NTR Gardens | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.6 km from route source

Selected hotspots:
- None

Why no hotspot was selected:
- This is the last airport-return route and its end time is `12:00 PM` or earlier, so the current rule makes it transfer-only.
- The persisted route only contains an `item_type = 7` airport transfer row, which means sightseeing rows were intentionally skipped.
- Even though candidates such as Ramoji Film City, Sri Chilkur Balaji Temple, Calvary Temple are eligible in the generic pool, the transfer-only rule stops them from being persisted on this last day.
