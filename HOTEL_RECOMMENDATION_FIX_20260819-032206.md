# Hotel recommendation fix — 2026-08-19 03:22:06 IST

## Scope

Local-only verification for itinerary `DVI20260847` / plan `10124`. No commit, push, PR, staging deployment, or production deployment was performed.

## Before

The recommendation allocation could reuse the same physical hotel too early. Category filtering and meal-plan selection could also cause authoritative metadata or selected nested-rate identity to be lost during deduplication and persistence.

Representative pre-fix allocation shape:

```text
Munnar continuous stay [10719, 10720]
G1 = AURUM RESORT
G2 = AURUM RESORT
G3 = AURUM RESORT
G4 = AURUM RESORT
```

Representative identity risk:

```text
parent optionKey = CP
selected nested rate = MAP
selected price fields = stale CP values
```

## After

The allocator now uses two passes per logical stay:

```ts
// Pass 1: choose an unused physical property in category fallback order.
// Pass 2: reuse a property only after all usable properties are exhausted.
```

The continuous Munnar stay is treated as one logical stay, while its two route rows retain their own dates. Authoritative rows now win deduplication and preserve category, fallback, selection-origin, selected-rate, and price-snapshot metadata. Nested MAP selections replace the parent CP identity and money atomically. G4 fallback objects are cloned.

The temporary frontend `HOTEL_PANE_INVENTORY_TRACE` logging was removed.

## Local database evidence after reset

The reset cache contained `49` hotel rows for every Munnar route/group (`10719` and `10720`, groups `0` through `4`) and the complete hotel-name set was identical across groups.

Persisted selections for the continuous stay were:

| Group | Hotel | Provider/code | Selected rate | Selected price |
|---|---|---|---|---:|
| G1 | AURUM RESORT | axisrooms / 231 | `axisrooms:231:604:MAP_PLAN:2026-08-22` | ₹9,063 |
| G2 | Lake Forest Resorts By Hawk Hospitality | offline / 660 | `offline:660:2011:944:2026-08-22:2026-08-24` | ₹3,465 |
| G3 | Eastend Munnar | offline / 504 | `offline:504:1519:680:2026-08-22:2026-08-24` | ₹3,869.80 |
| G4 | SPRING MUNNAR | offline / 117 | `offline:117:325:179:2026-08-22:2026-08-24` | ₹6,050 |

The same physical hotel selection was persisted for both nights of the continuous stay within each group, and different groups received different physical properties.

The persisted cache rows reported `recommendation_algorithm_version = v2` and retained authoritative recommendation metadata.

## Chrome verification

URL:

```text
http://localhost:8080/itinerary-details/DVI20260847
```

After reset, the hotel table showed the following for both Munnar dates:

```text
Recommended #1 = AURUM RESORT
Recommended #2 = Lake Forest Resorts By Hawk Hospitality - 3*
Recommended #3 = Eastend Munnar
Recommended #4 = SPRING MUNNAR
```

Other acceptance observations:

```text
Kovalam = JEEVAN BEACH RESORT -2* OFFLINE
Kovalam meal display = CP + MAP requested — price unavailable.
Rameswaram = Daiwik Hotels Rameswaram
MAP/CP fallback remained visible for applicable rows.
```

## Tests and builds

```text
Backend focused suites: 117 passed, 0 failed
Backend build: passed
Frontend hotel-list tests: 18 passed, 0 failed
Frontend Vite build: passed
Frontend full lint: known pre-existing repository failure (1,144 errors, 94 warnings)
Target HOTEL_PANE_INVENTORY_TRACE scan: clean
```

The Vite build emitted existing warnings about stale Browserslist data, an ambiguous Tailwind duration class, mixed static/dynamic imports, and large chunks; none blocked the build.

