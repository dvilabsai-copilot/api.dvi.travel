# Client-Ready Hotspot Decision Report

Generated: 2026-04-10T07:24:02.017Z
Input runner artifact: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\south-india-hotspot-analysis-1775805629365.json
Input server log: c:/wamp64/www/dvi_fullstack/api.dvi.travel/hotspot-debug-server.log

## Priority Semantics
Priority currently behaves as preference, not guarantee. It is applied in ordering, but timing and duplicate checks can override it.

## Priority Impact (Summary)
- Priority 0: fetched=608, attempted=628, selected=120, rejected=508
- Priority 1: fetched=448, attempted=452, selected=24, rejected=428
- Priority 2: fetched=68, attempted=76, selected=20, rejected=56
- Priority 3: fetched=66, attempted=66, selected=24, rejected=42
- Priority 4: fetched=40, attempted=42, selected=14, rejected=28
- Priority 5: fetched=44, attempted=44, selected=12, rejected=32
- Priority 6: fetched=70, attempted=70, selected=16, rejected=54
- Priority 7: fetched=36, attempted=36, selected=10, rejected=26
- Priority 8: fetched=10, attempted=10, selected=6, rejected=4
- Priority 9: fetched=10, attempted=10, selected=6, rejected=4
- Priority 10: fetched=8, attempted=10, selected=0, rejected=10
- Priority 11: fetched=8, attempted=8, selected=2, rejected=6
- Priority 12: fetched=2, attempted=2, selected=0, rejected=2
- Priority 13: fetched=2, attempted=2, selected=2, rejected=0
- Priority 14: fetched=2, attempted=2, selected=0, rejected=2
- Priority 18: fetched=26, attempted=26, selected=6, rejected=20
- Priority 19: fetched=6, attempted=6, selected=2, rejected=4
- Priority 20: fetched=6, attempted=6, selected=2, rejected=4
- Priority 21: fetched=6, attempted=6, selected=0, rejected=6

## Timing Override Counts
- closed at visit time: 260
- deferred to next opening slot: 42
- duplicate: 376
- excluded: 0
- day-of-week mismatch: 384
- no remaining day window: 174
- other: 0

## Bucket Report
- Selected by bucket:
  - unknown: 266
- Rejected by bucket:
  - prefilter: 384
  - unknown: 852

## Final vs Intermediate Decision (count)
Rows with both selected and rejected attempts: 0

## Client Options
- Option A: Keep current logic
- Option B: Priority-1 guaranteed if route-matched
- Option C: Priority-aware but time-adjusted scheduling

## Artifact Files
- JSON: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-1775805842017.json
- CSV: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-matrix-1775805842017.csv
- Markdown: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-1775805842017.md
