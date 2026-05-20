import { buildRebuildReport } from "../../src/modules/itineraries/engines/helpers/rebuild-report.helper";
import { queueDeferredMustVisitHotspot } from "../../src/modules/itineraries/engines/helpers/deferred-retry.helper";
import { RebuildWarningSeverity } from "../../src/modules/itineraries/engines/helpers/types";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function testWarningSeverityClassification(): void {
  const critical = buildRebuildReport({
    planId: 100,
    attemptedHotspotCount: 6,
    scheduledHotspotCount: 4,
    shiftedItems: [],
    droppedItems: [{ priority: 2 }],
  });

  assert(
    critical.warnings.some((w) => w.severity === RebuildWarningSeverity.RED),
    "must-visit drop should produce RED warning",
  );
  assert(critical.rebuildSummary.hasCriticalIssues, "summary should be critical for must-visit drops");

  const optionalDrop = buildRebuildReport({
    planId: 101,
    attemptedHotspotCount: 6,
    scheduledHotspotCount: 5,
    shiftedItems: [],
    droppedItems: [{ priority: 5 }],
  });

  assert(
    optionalDrop.warnings.some((w) => w.severity === RebuildWarningSeverity.ORANGE),
    "optional drop should produce ORANGE warning",
  );
  assert(!optionalDrop.rebuildSummary.hasCriticalIssues, "optional drops should not be critical");

  const shiftedOnly = buildRebuildReport({
    planId: 102,
    attemptedHotspotCount: 5,
    scheduledHotspotCount: 5,
    shiftedItems: [{ hotspotId: 11 }],
    droppedItems: [],
  });

  assert(
    shiftedOnly.warnings.some((w) => w.severity === RebuildWarningSeverity.YELLOW),
    "shifted hotspots should produce YELLOW warning",
  );

  const clean = buildRebuildReport({
    planId: 103,
    attemptedHotspotCount: 3,
    scheduledHotspotCount: 3,
    shiftedItems: [],
    droppedItems: [],
  });

  assert(
    clean.warnings.length === 1 && clean.warnings[0].severity === RebuildWarningSeverity.GREEN,
    "clean rebuild should produce single GREEN warning",
  );
}

function testDeferredMustVisitQueue(): void {
  const deferred: Array<{ hotspot_ID: number; hotspot_priority: number }> = [];
  const deferredIds = new Set<number>();
  const hotspot = { hotspot_ID: 77, hotspot_priority: 2 };

  const queued = queueDeferredMustVisitHotspot(
    deferred,
    deferredIds,
    hotspot,
    1,
    true,
  );
  assert(queued, "stage-A must-visit should queue during pass 1");
  assert(deferred.length === 1, "queued hotspot should be added once");

  const duplicate = queueDeferredMustVisitHotspot(
    deferred,
    deferredIds,
    hotspot,
    1,
    true,
  );
  assert(!duplicate, "duplicate hotspot should not be queued twice");
  assert(deferred.length === 1, "deferred queue should remain deduplicated");

  const passTwo = queueDeferredMustVisitHotspot(
    deferred,
    deferredIds,
    { hotspot_ID: 78, hotspot_priority: 1 },
    2,
    true,
  );
  assert(!passTwo, "queue helper should only add candidates during pass 1");
}

function run(): void {
  testWarningSeverityClassification();
  testDeferredMustVisitQueue();
  console.log("[hotspot-engine-parity] All checks passed.");
}

run();