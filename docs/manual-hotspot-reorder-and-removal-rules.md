# Manual Hotspot Reorder And Removal Rules

## Goal

When a user manually adds a hotspot with `Fit Here`, the selected manual hotspot is the primary objective.

The backend must try to make that selected hotspot work before saying `cannot fit`.

## Core Rules

1. The selected manual hotspot is protected.
2. Already-active manual hotspots are protected.
3. Non-manual hotspots may be pushed later, reordered, or removed if needed.
4. Every kept hotspot must still obey operating hours after the rebuild.
5. If the selected manual hotspot has multiple operating windows, the solver must keep trying later valid windows when possible.
6. `Cannot fit` should be returned only after all allowed non-manual rescue options are exhausted.

## Exact Anchor Rule

For `Fit Here`, the clicked anchor must stay respected.

- If the user clicked `After Start`, the selected manual hotspot must stay immediately after the route start boundary.
- If the user clicked `After Attraction`, the selected manual hotspot must stay after that anchor hotspot.

What is allowed after that:

- Downstream non-manual hotspots may be reordered.
- Downstream non-manual hotspots may be delayed into later valid opening windows.
- Downstream non-manual hotspots may be removed according to priority rules.

What is not allowed:

- Moving the selected manual hotspot away from the clicked anchor.
- Removing any manual hotspot.

## Search Strategy

For an exact-anchor preview/apply flow, the backend should evaluate multiple anchor-preserving strategies, not just original route order.

Recommended strategy family:

1. Keep original downstream order.
2. Reorder downstream by earliest closing window first.
3. Reorder downstream by higher priority first, then earlier closing window.
4. Reorder downstream by nearest-next movement as a tie-break route shape.
5. If allowed, retry after removable P3 hotspots are excluded.

## Removal Rules

Removal order should be:

1. Optional / lower-priority non-manual hotspots.
2. P3 hotspots if confirmation/removal policy allows.
3. P2 hotspots only if policy allows.
4. P1 hotspots only if policy allows.

Never remove:

- The selected manual hotspot.
- Any other manual hotspot already active on the route.
- Anchor-protected hotspots explicitly marked as non-removable for the current attempt.

## Candidate Selection Rules

When comparing two feasible solutions:

1. Prefer the one with fewer total removals.
2. If tied, prefer the one that removes fewer higher-priority hotspots.
3. If tied, prefer fewer operating-hour conflicts.
4. If tied, prefer lower route-end overflow.
5. If tied, prefer less waiting.
6. If tied, prefer less extra detour.

This means wait time and detour are tie-breakers, not primary blockers, as long as the rebuilt route still finishes within the allowed manual timing window.

## UI Meaning

The UI should not show `cannot fit` just because the first attempted order failed.

`Cannot fit` is correct only when:

- the selected manual hotspot still cannot be scheduled after all allowed downstream reorder attempts, and
- all allowed non-manual removals have been exhausted, and
- only protected manual hotspots remain as blockers.

## Timeline Expectation

If the solver chooses a feasible solution, the preview should show the full journey clearly, including:

- start / refreshment
- travel to anchor hotspot
- stay at anchor hotspot
- travel to selected manual hotspot
- stay at selected manual hotspot
- downstream travel/stays after reorder if any

Example expectation:

- `Start`
- `Refreshment`
- `Travel to Meenakshi`
- `Stay at Meenakshi`
- `Travel to Gandhi`
- `Stay at Gandhi`

## Current Backend Direction

The backend implementation should favor:

- anchor-preserving exact-fit attempts
- downstream reorder strategies
- operating-window-aware waiting
- progressive non-manual removal
- final `cannot fit` only after protected-manual-only blockage remains
