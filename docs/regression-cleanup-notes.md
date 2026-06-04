# Regression Cleanup Notes

Current expected suite shape:
- Total cases: 15
- Passed: 14
- Failed: 1
- Known hard failure: `regression-case-01` `DUPLICATE_TRUE_CONFLICT`

Case 13 note:
- `regression-case-13` is expected to report `EXPECTED_REBUILD_MANUAL_CLEANUP` as a warning when a full rebuild clears the manual hotspot.

Temporary debug helpers kept for investigation:
- `scripts/regression/debug-failed-case.js`
- `scripts/regression/debug-empty-intercity-fill.js`
- `scripts/regression/debug-case09-location-contamination.js`

Temporary trace artifacts remain under `tmp/` for reference during regression work.
