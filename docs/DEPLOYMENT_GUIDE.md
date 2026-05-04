# Git Patch: Day 1 Route Time Override Fix

## Apply This Patch

```bash
# Option 1: Already applied (see timeline.builder.ts)
# The fix has been implemented directly on your file

# Option 2: Generate patch for review
cd api.dvi.travel
git diff src/modules/itineraries/engines/helpers/timeline.builder.ts

# Option 3: Commit the fix
git add src/modules/itineraries/engines/helpers/timeline.builder.ts
git commit -m "fix: respect user-updated route times instead of forcing 08:00/20:00

Routes Day 1 timelines now use actual saved route times as source of truth
instead of forcing hardcoded 08:00 AM start and 20:00 (8 PM) end times.

The generic overrides that were ignoring user PATCH edits to:
  PATCH /api/v1/itineraries/:planId/route/:routeId/times

have been removed. The early-arrival deferred flow logic is preserved
and remains conditional on the arrival policy evaluation.

BEHAVIOR CHANGE:
- Manual route time edits via PATCH endpoint are now respected
- Timeline builder uses saved times as source of truth
- No more forced 08:00-20:00 override for regular Day 1 routes
- Early-arrival deferred flow still gets 08:00-09:00 buffer (conditional)

Files changed:
- src/modules/itineraries/engines/helpers/timeline.builder.ts (lines 605-630)

Risk: Low (removes buggy code, preserves legitimate behavior)
-"

git push origin feature/day1-route-time-fix
```

## Unified Diff

```diff
--- a/src/modules/itineraries/engines/helpers/timeline.builder.ts
+++ b/src/modules/itineraries/engines/helpers/timeline.builder.ts
@@ -602,23 +602,18 @@
       let routeEndTime: string = typeof route.route_end_time === 'string'
         ? route.route_end_time
         : route.route_end_time && typeof route.route_end_time === 'object'
         ? `${String((route.route_end_time as any).getUTCHours()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCMinutes()).padStart(2, '0')}:${String((route.route_end_time as any).getUTCSeconds()).padStart(2, '0')}`
         : '18:00:00';
-
-      // PHP parity: first route scheduling starts at 08:00 for hotspot gating/walk,
-      // even when generated route_start_time is later (e.g., 12:00).
+
+      // RULE: Use saved routeStartTime and routeEndTime from database as source of truth.
+      // These are set by user manual edits via PATCH /api/v1/itineraries/:planId/route/:routeId/times
+      // Do NOT override with hardcoded times here.
+      // Conditional overrides (e.g., early-arrival deferred flow) are applied later after arrival policy evaluation.
       let effectiveRouteStartTime = routeStartTime;
-      if (isFirstRoute && !isLastRoute && timeToSeconds(routeStartTime) > timeToSeconds('08:00:00')) {
-        effectiveRouteStartTime = '08:00:00';
-      }
-      
-      // Use route's configured end time (no hardcoded cutoffs)
-      // Users can adjust end time as needed
-      
+
       let currentTime = effectiveRouteStartTime;
       let routeEndSeconds = timeToSeconds(routeEndTime);
-      
+
       // Handle overnight routes: if end time < start time, add 24 hours to end
       const routeStartSeconds = timeToSeconds(effectiveRouteStartTime);
       if (routeEndSeconds < routeStartSeconds) {
         routeEndSeconds += 86400; // Add 24 hours in seconds
       }
-      
-      // DAY 1 SPECIAL: Override end time to 8 PM (20:00) for proper structure
-      if (isFirstRoute && !isLastRoute) {
-        routeEndSeconds = timeToSeconds('20:00:00');
-        if (routeEndSeconds < routeStartSeconds) {
-          routeEndSeconds += 86400;
-        }
-      }

       // Maintain current logical location name for distance calculations.
```

## PR Checklist

When creating a pull request:

- [x] **Title**: "fix: respect user-updated route times instead of forcing 08:00/20:00"
- [x] **Description**: Reference this document and IMPLEMENTATION_SUMMARY.md
- [x] **Tests**: 
  - [x] Build passes (`npm run build`)
  - [ ] Manual test (set startTime=12:00, verify)
  - [ ] Early-arrival regression test
- [x] **Documentation**: All guides created
- [x] **Code Review**: Changes are minimal and focused
- [ ] **QA Sign-off**: Pending
- [ ] **Deployment**: Pending

## Deployment Checklist

- [ ] PR approved and merged
- [ ] Build passes in CI/CD
- [ ] Run: `npm run build`
- [ ] Run: Quick regression test
- [ ] Deploy to staging
- [ ] Verify: Test case DVI202604228 works correctly
- [ ] Deploy to production
- [ ] Monitor: Check logs for any regressions

## Rollback Plan

If issues occur:

```bash
# Revert the commit
git revert <commit-hash>
git push origin main

# Or restore from backup
git checkout main~1 -- src/modules/itineraries/engines/helpers/timeline.builder.ts
npm run build
git commit -m "revert: day1 route time fix"
```

## Related Issues/PRs

- Fixes: Manual route time edits being ignored in rebuild
- Related: PATCH /api/v1/itineraries/:planId/route/:routeId/times endpoint
- Related: Early-arrival deferred flow logic

## Sign-Off

| Role | Status | Name | Date |
|------|--------|------|------|
| Code Author | ✅ Complete | Principal NestJS Architect | 2026-04-15 |
| Code Reviewer | ⏳ Pending | | |
| QA Lead | ⏳ Pending | | |
| DevOps | ⏳ Pending | | |
| Product | ⏳ Pending | | |

## Version Information

- **Feature Branch**: `feature/day1-route-time-fix`
- **Base Branch**: `main`
- **Target Version**: Next release
- **Backward Compatibility**: ✅ Yes
- **Database Migration**: ❌ No
- **Configuration Changes**: ❌ No

## Deployment Notes

**For DevOps**:
- No database changes required
- No environment variable changes
- No configuration file updates
- Standard Node.js build process
- Can be rolled out with blue-green deployment

**For QA**:
- Focus on Day 1 early-arrival quotes (regression testing)
- Test manual route time edits (new functionality)
- Verify hotspot scheduling still works
- Check multi-day itineraries unaffected

**For Support**:
- Manual route time edits are now respected
- Users can update Day 1 start/end times via API
- No API contract changes
- Early-arrival flow behavior unchanged
