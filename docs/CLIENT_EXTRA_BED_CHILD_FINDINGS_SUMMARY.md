# Extra Bed and Child Pricing Findings Summary

Date: 24-Apr-2026
Prepared for: Client sharing
Scope: Itinerary hotel pricing behavior, child/extra-bed occupancy impact, and overall cost breakdown visibility

## 1) Executive Summary
We investigated why hotel results and pricing changed after child and extra-bed data flow updates.

Main findings:
- Child and extra-bed traveler data is now correctly captured end-to-end (frontend -> backend -> persistence).
- Hotel search results are highly occupancy-dependent. The same stay can return many hotels for single-adult but zero for child-inclusive one-room occupancy.
- Kodaikanal missing hotels was primarily an occupancy/rate-plan eligibility issue, not a route-mapping issue.
- We restored route coverage by adding fallback behavior when child-inclusive occupancy returns zero.
- Overall cost rows for Extra Bed and Child With Bed were updated on UI to display consistently when counts are present.

Business impact:
- Improved transparency and continuity for itinerary generation.
- Reduced false "no hotels" outcomes for family occupancy scenarios.
- Clearer cost communication for extra bed and child-with-bed lines.

## 2) What Was Reported
Reported issues during this cycle:
- Kodaikanal hotels not appearing while Ooty appeared.
- Behavior changed after child-data updates.
- Need to confirm whether API prices include child/extra-bed breakdown.
- Need to display extra bed and child-with-bed amounts in overall cost section.

## 3) Root Causes Identified
### 3.1 Destination Mapping Key Mismatch (fixed)
- Stay blocks used normalized destination labels.
- City-code map initially indexed only raw destination strings.
- Result: avoidable city-code misses and placeholder/no-result patterns for some routes.

Resolution:
- Indexed city codes by both raw and normalized destination keys.

### 3.2 Child Ages Validation vs Search Payload (fixed)
- Search validation requires childAges length to match childCount when children are present.
- Itinerary hotel generation was sending childCount without childAges.

Resolution:
- Child ages are now derived from saved traveler rows and passed into hotel search criteria.

### 3.3 Runtime 500 Due to Wrong OrderBy Column (fixed)
- Child-age lookup query used an incorrect orderBy field name.

Resolution:
- Corrected to the actual traveler table primary key field.

### 3.4 Occupancy Restriction for One-Room Family Search (confirmed)
- For Kodaikanal (2026-05-01 to 2026-05-03):
  - roomCount=1, adults=3, children=2 returned zero hotels.
  - roomCount=1, adults=1 returned many hotels.
  - roomCount=2, adults=3, children=2 returned hotels.
- This is supplier/rate-plan occupancy eligibility behavior.

Resolution:
- Added fallback behavior: if child-inclusive search returns zero, retry once with adult-only occupancy to preserve route continuity.

## 4) Evidence Snapshot
### 4.1 Route Presence Check
For quote DVI202604242, itinerary routes included Ooty and Kodaikanal days, confirming destination data existed.

### 4.2 Direct API Comparison
Same destination/date window:
- Ooty (2 nights):
  - Current pax (3 adults + 2 children): fewer results and much higher minimum price.
  - Single adult: many more results and lower minimum price.
- Kodaikanal (2 nights):
  - Current pax with roomCount=1: zero results.
  - Single adult with roomCount=1: results returned.
  - Current pax with roomCount=2: results returned.

Conclusion: occupancy + room distribution materially changes both availability and pricing.

### 4.3 Post-Fix Route Coverage
After rebuild:
- Ooty rows present.
- Kodaikanal rows present.
- Route IDs for both destinations returned in hotel_details response.

## 5) Clarification on API Pricing Fields
### 5.1 hotel_details endpoint
- Returns per-hotel totals (example: totalHotelCost, totalHotelTaxAmount).
- Does not return per-row extra-bed/child-with-bed breakdown fields.

### 5.2 details endpoint (overall)
- Returns overall costBreakdown object.
- Extra-bed/child components are expected at this overall layer (not per hotel row).
- Depending on data conditions/selection, some keys may be absent in response if values are not populated.

## 6) UI Behavior Changes Completed
- OVERALL COST section updated to show:
  - Extra Bed Cost
  - Child With Bed Cost
- Display now appears when corresponding traveler counts are present, even if amount is 0, improving transparency.

## 7) Recommended Client-Facing Position
Suggested message:
- Hotel prices are dynamic and occupancy-sensitive.
- Family occupancy with one-room constraints can reduce inventory or increase rates.
- We implemented safeguards so itineraries remain usable even when strict child-inclusive search returns zero.
- We also improved cost visibility for extra bed and child-with-bed components.

## 8) Remaining Functional Notes
- For highest pricing accuracy, provider-compliant room distribution should be used (for example, multi-room splits for family occupancy) instead of forcing all travelers into one room.
- Adult-only fallback preserves continuity but can under-represent child-inclusive final payable unless explicitly adjusted in downstream costing.

## 9) Recommended Next Phase (when resumed)
1. Introduce explicit backend pricing contract for hotel total components:
   - baseHotelCost
   - extraBedCost
   - childWithBedCost
   - childWithoutBedCost
   - extraRoomCost
   - finalHotelCost
2. Add rooming strategy selection for family occupancy (auto-split by supplier limits).
3. Keep fallback, but label it in response metadata when applied.
4. Add audit fields in response for explainability:
   - requestedOccupancy
   - effectiveOccupancyUsed
   - fallbackApplied

## 10) Conclusion
The observed behavior was real and reproducible. The core issue was occupancy eligibility under one-room family search, amplified by earlier child payload/mapping defects. Those defects were addressed, route coverage was restored, and overall cost visibility was improved for extra bed and child-with-bed lines.
