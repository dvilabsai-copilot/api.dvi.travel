# Final departure editing

## Requirement and pre-edit analysis

DVI20261116 has a 21:00 route end but a saved 12:00 actual departure. The day
header sends ROUTE_END, which intentionally preserves the actual departure.
The scheduler therefore still applies a 10:00 report deadline for its saved
flight type and suppresses sightseeing. This contract separation dates to
July 21, 2026 (backend c1f351b7 and frontend f4e4e1bb).

The intended outcome is a separate final-day Departure control using the existing
FINAL_DAY_DEPARTURE operation. Saving 21:00 actual departure must atomically save
the actual departure, derive the 19:00 flight cutoff and rebuild feasible unused
visits. Existing day-end and start controls retain their semantics. The saved
departure type remains authoritative: flight minus two hours, train minus one,
road without a buffer. Midnight and overnight handling remains in the existing
timing service. A non-final route cannot change the final departure.

Both admin and Travel Expert headers use one departure control. The shared route
time controller must compare a departure edit with departureTime, not endTime,
and must not request a Day-1 early-arrival choice for a departure-only edit.
This also matters on single-day itineraries. API field names and response shape
remain unchanged. Existing route timing rebuild, parking and vehicle pricing
refreshes are retained. Manual rows, exclusions, hotel selection and arrival
preferences must be preserved.

For a final day containing only a persisted departure transfer and no real start
row, the details API must omit its synthetic start/breakfast segment. Real
refreshment rows and ordinary sightseeing-day labels remain unchanged.

No scheduler ordering, corridor ownership, priorities, waterfall pins, November
priority rules, hotel/provider contracts or pricing algorithms are changed.

## Predicted regression matrix

| Scenario | Predicted outcome |
| --- | --- |
| DVI20261116 departure 21:00 | Header departure 21:00, cutoff 19:00, feasible sightseeing rebuilt |
| Ordinary route-end edit | Actual departure preserved |
| Flight / train / road | Existing 2h / 1h / 0h buffer retained |
| Single-day early arrival | Departure edit bypasses arrival-choice dialogs |
| Same departure / different route end | No false departure edit; compare actual departure |
| Missing departure value | No invented fallback departure or edit control |
| Invalid time / non-final route | Existing validation, plus final-route ownership guard |
| Read-only / busy | Departure edit disabled |
| Repeated save / reload | Stable saved departure, cutoff and unique visits |
| Transfer-only with no start row | No synthetic breakfast gap |
| Real start row / sightseeing day | Existing display retained |
| Rebuild or restriction failure | Transaction rolls back; existing error handling retained |
| November / waterfalls | Existing ordering, detour and operating-window protections retained |

## Verification

Use focused frontend component/controller tests and backend timing/display tests,
both builds, then staging browser tests for the original quote, flight/train/road
departures, a single-day trip, ordinary day-end edits and Cochin-Munnar control
quotes. Snapshot staging state before test mutations and restore temporary edits.
Review the final diff and verify the deployed commits descend from current
staging so November, waterfall and concurrent staging changes are retained.
