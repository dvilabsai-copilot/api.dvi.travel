## What changed
This updates the itinerary vehicle build flow so local vehicle pricing uses the same visible local pricebook mapping shown in the vendor UI, and so `vehicle-build-sync` retries once when a transient overlapping build leaves the first sync call without usable rows.

## Why it changed
Two issues were causing unstable vehicle builds:
1. Local pricebook preview could show a visible slab price even when the stored local pricebook row used an older mismatched `time_limit_id`. The vehicle builder previously required an exact row match, so visible vendor pricing could still be skipped during itinerary build.
2. `vehicle-build-sync` could return a 500 when two builds for the same plan overlapped and one run checked status before usable rows from the other run were committed.

## Impact
- Vendor-visible local slab pricing now participates in itinerary vehicle build even when older local pricebook rows need remapping by slab signature.
- The first transient sync build failure now self-recovers instead of surfacing a 500 immediately.

## Root cause
The vehicle builder and the vendor local pricebook preview were using different matching rules for local slab rows, and the sync build endpoint treated a temporary no-usable-rows state as a hard failure.

## Validation
- `npm run build`
