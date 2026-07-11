
## Scenario 5

- Quote ID: `DVI20260798`
- Plan ID: `9871`
- Generated: 2026-07-11T08:03:02.248Z
- Snapshot source: current persisted DB state at generation time

### Plan Summary

- Arrival: Hyderabad, Rajiv Gandhi International Airport
- Departure: Hyderabad, Rajiv Gandhi International Airport
- Trip window: 2026-07-12 05:00 AM -> 2026-07-14 01:00 PM
- Days / nights: 3 days, 2 nights
- Arrival type: 1
- Departure type: 1

### Plain-English Overview

- For quote `DVI20260798`, the engine builds each day by first finding source / via / destination hotspot candidates, then ordering them by priority, and finally keeping only the ones that fit the day's timing window.
- In this quote, Day 1 keeps 2 hotspot(s), Day 2 keeps 5 hotspot(s), and Day 3 keeps 0 hotspot(s).

### Global Rules Used In This Analysis

- Auto hotspot ranking uses lower numeric `hotspot_priority` first; `0` is treated as lowest/optional.
- `direct_to_next_visiting_place = 0` means the route can pull from source + via + destination buckets, with source auto hotspots limited to top 3.
- Manual hotspots would stay in the pool as effective priority `4`, but this quote currently has no manual hotspot rows.
- Last-route airport logic suppresses sightseeing when the final route ends at or before `12:00 PM`.
- Persisted attraction rows (`item_type = 4`) are treated as the final selected hotspots for the day.
- Candidate-pool ranking explains why a hotspot was eligible; the persisted order is the final source of truth for what actually survived schedule fit.

### Day 1

- Route ID: `8605`
- Date: 2026-07-12
- Source: Hyderabad, Rajiv Gandhi International Airport
- Destination: Hyderabad, Telangana, India
- Route window: 05:00 AM -> 08:00 PM
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
   Persisted route hotspot row: `131717`
   Why selected: master priority is 1, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early
   Why selected: persisted travel leg reaches it at 10:01 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 06:00 PM
2. Macca Masjid
   Travel into hotspot: 05:01 PM -> 05:56 PM
   Visit window: 05:56 PM -> 06:16 PM (20m)
   Persisted route hotspot row: `131728`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: this is on Day 1, so source-city ranking and the Day-1 arrival-day scheduler both influence whether it is considered early
   Why selected: persisted travel leg reaches it at 05:56 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 04:00 AM -> 08:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone

Notable eligible but unpersisted candidates:
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Calvary Temple | raw priority 15 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Sudha car museum hyd | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Taj Falaknuma Palace, Hyderabad | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Statue Of Equality | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions

### Day 2

- Route ID: `8606`
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
- Source matches: 23 total, top-3 used for non-direct source bucket
- Destination matches: 23
- Via matches: 0
- Boundary matches: 0
- Manual matches: 0
- Final merged candidate count before schedule fit: 23

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
6. Snow World | raw priority 0 | effective priority 9999 | buckets: source, destination | 1.5 km from route source
7. Hussain Sagar Lake | raw priority 0 | effective priority 9999 | buckets: source, destination | 2.7 km from route source
8. Salar Jung Museum | raw priority 0 | effective priority 9999 | buckets: source, destination | 5.8 km from route source

Selected hotspots in persisted order:
1. Calvary Temple
   Travel into hotspot: 09:00 AM -> 09:33 AM
   Visit window: 09:33 AM -> 10:33 AM (1h)
   Persisted route hotspot row: `131716`
   Why selected: master priority is 15, so it is treated as a priority hotspot instead of optional filler
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 09:33 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 07:00 PM
2. Charminar
   Travel into hotspot: 10:33 AM -> 11:13 AM
   Visit window: 11:13 AM -> 12:13 PM (1h)
   Persisted route hotspot row: `131719`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 11:13 AM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:00 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
3. Qutub Shahi Tombs
   Travel into hotspot: 12:13 PM -> 12:33 PM
   Visit window: 12:33 PM -> 01:33 PM (1h)
   Persisted route hotspot row: `131721`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 12:33 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 05:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
4. Sudha car museum hyd
   Travel into hotspot: 01:33 PM -> 02:27 PM
   Visit window: 02:27 PM -> 03:27 PM (1h)
   Persisted route hotspot row: `131723`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 02:27 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 09:30 AM -> 06:30 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone
5. Birla Mandir
   Travel into hotspot: 03:27 PM -> 04:16 PM
   Visit window: 04:16 PM -> 05:46 PM (1h 30m)
   Persisted route hotspot row: `131725`
   Why selected: master priority is 0, so it behaves as an optional/filler hotspot and only appears after stronger priority candidates are considered
   Why selected: candidate bucket matches: source, destination
   Why selected: persisted travel leg reaches it at 04:16 PM, which means the scheduler found a usable travel + visit slot inside the route window
   Why selected: operating-hours evidence for route day: 07:00 AM -> 12:00 PM
   Why selected: because it is optional, its exact order against other priority-0 hotspots depends on schedule fit and travel sequence, not on priority alone

Notable eligible but unpersisted candidates:
- Ramoji Film City | raw priority 1 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Sri Chilkur Balaji Temple | raw priority 10 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- B.M. Birla Science Museum | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Snow World | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions
- Hussain Sagar Lake | raw priority 0 | buckets: source, destination | not persisted on this route, so it likely lost on timing / fit / later scheduling decisions

### Day 3

- Route ID: `8607`
- Date: 2026-07-14
- Source: Hyderabad, Telangana, India
- Destination: Hyderabad, Rajiv Gandhi International Airport
- Route window: 08:00 AM -> 01:00 PM
- Via locations: none
- Distance on route row: 34.80

Human-readable selection story:
- This day starts in Hyderabad, Telangana, India and ends in Hyderabad, Rajiv Gandhi International Airport, so the engine treats it as a same-city route for hotspot selection.
- Because this route is not marked direct, the engine is allowed to consider top source-city hotspots first, then via hotspots, then destination-side hotspots.
- No attraction rows were persisted for this day, which means every sightseeing candidate lost to timing, fit, or route-end protection.

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

Selected hotspots:
- None

Why no hotspot was selected:
- The persisted route only contains an `item_type = 7` airport transfer row, which means sightseeing rows were intentionally skipped.
- Even though candidates such as Ramoji Film City, Sri Chilkur Balaji Temple, Calvary Temple are eligible in the generic pool, the transfer-only rule stops them from being persisted on this last day.

