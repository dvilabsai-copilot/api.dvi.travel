# Hotel recommendation local fix — 2026-08-19 01:50:24 IST

## Scope

Local-only fix and verification for the Kovalam recommendation regression in DVI20260847. No commit, push, PR, merge, or deployment was performed.

## Confirmed issue before the fix

`HotelRecommendationPackageService.buildOptions()` built live and offline candidates, but selected only the live array whenever any live option existed:

```ts
const selected = (live.length > 0 ? live : offline).sort(compareOptions);
```

That made provider availability act as a category filter. A live 4-star hotel could prevent a valid priced offline 2/3-star hotel from participating in category fallback.

The snapshot reconciliation path had the same live-provider gate when replacing automatic selections.

## Fix applied

Live and offline/local candidates are now compared in one pool. Category fallback decides the automatic selection; provider class does not partition the inventory:

```ts
const selected = [...live, ...offline].sort(compareOptions);
```

Snapshot reconciliation now keeps all meal-plan-compatible authoritative options:

```ts
const eligibleOptions = selectionPool;
```

The existing category fallback order remains authoritative:

```text
2* -> 2*, 3*, 4*, 5*
3* -> 3*, 2*, 4*, 5*
4* -> 4*, 3*, 2*, 5*
5* -> 5*, 4*, 3*, 2*
```

All four recommendation groups receive the same complete inventory. Category and price rules affect only the automatic selection.

## Local Kovalam evidence

For city `48387`, stay dates `2026-08-26` and `2026-08-27`, the database contained five active local hotels. Only JEEVAN BEACH RESORT had positive price-book values for both nights. The other four active catalog hotels had no positive August 2026 price-book values and were therefore not fabricated as zero-price selectable offers.

```text
JEEVAN BEACH RESORT       STD/logical 2*   priced for both nights   selectable
Aadisaktthi Resorts       3*              no positive prices         excluded from priced offers
Gokulam Grand Turtle      4*              no positive prices         excluded from priced offers
Ocean bay Beach Resort    Budget/logical 2* no positive prices       excluded from priced offers
The Byke Puja Samudra     3*              no positive prices         excluded from priced offers
```

## Chrome verification after reset

Local Chrome at:

```text
http://localhost:8080/itinerary-details/DVI20260847
```

showed the reset result with four recommendation tabs and Kovalam Day 5 selected as:

```text
JEEVAN BEACH RESORT -2* OFFLINE
room: SEA SHELL
meal plan: CP
```

The page retained all itinerary dates and rendered the shared recommendation tabs. The temporary Kovalam debug logs were removed after verification.

## Regression coverage

```text
hotel-recommendation-package.test.ts       31 passed
hotel-availability-snapshot.test.ts       59 passed
itinerary-plan-persistence.test.ts        16 passed
backend build                               passed
frontend Vite compile (--emptyOutDir false) passed
```

The frontend test suite had three pre-existing login selector failures unrelated to hotel changes. The normal Vite build could not empty the existing Windows-locked `dist/assets` directory; compilation itself passed when output cleanup was disabled.
