# Hotel Recommendation Fix — 2026-08-19 01:59:39 IST

## Scope

Local-only documentation for the hotel recommendation/shared-inventory fix. No commit, push, pull request, merge, or deployment was performed.

## Issue

When live provider inventory existed, the recommendation builder ignored offline/local offers. This allowed a live higher-category hotel to prevent a valid local lower-category fallback from being selected.

The snapshot reconciliation path also treated provider type as an eligibility gate.

## Before

### Recommendation candidate pool

```ts
const selected = (live.length > 0 ? live : offline).sort(compareOptions);
```

Effect: if any live offer existed, offline/local offers were discarded before category selection.

### Snapshot reconciliation

```ts
const eligibleOptions = selectionPool.filter(option =>
  allowOfflineAutoSelection ||
  option.provider !== 'offline' ||
  !hasMatchingLiveOption,
);
```

Effect: live availability could block a valid offline/local candidate even when its category and price were correct.

## After

### Recommendation candidate pool

```ts
// Provider type does not determine the category fallback.
// Compare live and offline/local offers together.
const selected = [...live, ...offline].sort(compareOptions);
```

### Snapshot reconciliation

```ts
// Provider class is not a category or availability filter.
// The pool is already meal-plan compatible.
const eligibleOptions = selectionPool;
```

## Selection policy preserved

```text
2* -> 2*, 3*, 4*, 5*
3* -> 3*, 2*, 4*, 5*
4* -> 4*, 3*, 2*, 5*
5* -> 5*, 4*, 3*, 2*
```

Category and price rules determine the automatic selection only. Every recommendation group continues to receive the complete shared hotel inventory.

## Metadata changes

Selected hotel snapshots now preserve the requested category, selected category, and fallback reason:

```ts
requestedCategory
selectedCategory
categoryFallbackApplied
categoryFallbackReason
```

The frontend can therefore explain a fallback without relabelling the selected hotel as the requested category.

## Verification

```text
Backend focused tests: 106 passed
Backend build: passed
Frontend hotel tests: 18 passed
Frontend Vite build: passed with --emptyOutDir false
Chrome local reset: Kovalam selected JEEVAN BEACH RESORT -2* OFFLINE
```

The normal frontend build cleanup was blocked by an existing Windows file lock in `dist/assets`; compilation succeeded when Vite was run without emptying the output directory. Full frontend lint has unrelated pre-existing failures.
