# Current Behaviour Baseline

Captured before production refactoring on 2026-07-16.

## Repository and runtime

- Backend: `api.dvi.travel`, branch `main`, commit `aec9541`
- Frontend: `dvi_frontend`, branch `main`, commit `b2bbaec`
- Backend: NestJS 10, Prisma 5.20, MySQL datasource, TypeScript build target ES2021
- Frontend: React 18, Vite 5, Vitest 4, Playwright 1.59
- REST prefix: `/api/v1`; GraphQL: `/api/v2/graphql`
- Database credentials and production identifiers are intentionally not recorded.

## Executed unchanged checks

| Scenario/check | Command | Result | Evidence/notes |
|---|---|---|---|
| Backend compile | `npm run build` in `api.dvi.travel` | PASS | TypeScript emitted successfully |
| Backend focused unit/algorithm suite | `npx tsx --test ...` | 13 PASS, 1 FAIL | Existing `route-optimizer-normalization.test.ts` fails at line 102 (`2 !== 1`); no production change was made |
| Frontend unit/component suite | `npm run test -- --run` | PASS, 4 files / 9 tests | Existing React Router and `act()` warnings only |
| Frontend production build | `npm run build` | PASS | Existing large chunks and dependency warnings |
| Prisma schema validation | `npx prisma validate` | PASS | MySQL schema parsed successfully |
| OpenAPI generation | `npm run openapi:generate` | PASS | Configured MySQL connection initialized; 499 paths written |
| OpenAPI self-comparison | `npm run openapi:compare` | FAIL with existing findings | 603 routes match; 14 duplicate operation IDs and 2 broken schema references |
| Frontend lint | `npm run lint` | FAIL | 1,636 errors and 82 warnings in existing code/assets; no lint-only cleanup included |
| Backend integration/API tests | not run | BLOCKED/PENDING | Requires an isolated MySQL fixture and safe test credentials |
| Swagger/OpenAPI baseline | pending first generator run | PENDING | Generator added in `scripts/generate-openapi.ts` |
| Playwright critical itinerary workflows | not run | PENDING | Existing suites require configured E2E environment/fixtures |

## Behaviour scenarios to characterize

1. Open `/itinerary-details/:quoteId`; verify details load, route order, timeline order, travel legs, distance/duration and pricing display.
2. Open manual hotspot preview; verify preview-only state does not persist; confirm preserves selected hotspot and ordering.
3. Save/rebuild itinerary; verify route order, timings, hotels, vehicles and database changes.
4. Open `/confirmed-itinerary/:id`; verify confirmed details and voucher/account data.
5. Exercise static itinerary routes before `GET /itineraries/:id` to detect route swallowing.
6. Exercise vendor/hotel/activity/location/hotspot list/search/filter paths with status/deleted handling.

## Measurement policy

No query count, database duration, row count, payload size, or endpoint timing is claimed until collected from an isolated fixture or a read-only audit. The first implementation cycle therefore captures structure and test status only.
