# PLAYWRIGHT ITINERARY E2E REPORT

- Started: 2026-04-11T20:17:52.698Z
- Finished: 2026-04-11T20:18:05.862Z
- Status: FAILED
- Quote ID: DVI202604228
- Plan ID: 266

## What Was Tested
- Created a new realistic 7-day itinerary via authenticated API save path.
- Scenario includes 2-night continuity, via-route data, and a direct-destination day.
- Verified itinerary details API returns 7 route days.
- Validated day-2 continuation behavior against day-1 destination (2-night stay signal).
- Validated via-route and direct-destination persistence from itinerary edit API.
- Opened itinerary details page successfully and confirmed day rows from DAY 1 to DAY 7 are visible.

## Initial Failures
- [2mexpect([22m[31mreceived[39m[2m).[22mtoBeTruthy[2m()[22m

Received: [31mfalse[39m

## Fixes Applied
- No application code changes were required from this test run.

## Remaining Risks / Follow-ups
- If any instability appears in CI/headless, rerun in headed mode and inspect retained trace/video artifacts.

## Screenshot Checkpoints
- C:\wamp64\www\dvi_fullstack\dvi_frontend\test-results\itinerary-7day-headed-live-940fb--with-planner-edge-coverage-chromium\1775938682566-01-details-loaded.png

## Re-run (Headed)
- cd dvi_frontend
- npm run e2e:headed -- tests/e2e/itinerary-7day-headed-live.spec.ts

## Notes
- This suite runs in headed mode when executed with the command above.
- Playwright trace/video are already configured in the existing project config (retain-on-failure).