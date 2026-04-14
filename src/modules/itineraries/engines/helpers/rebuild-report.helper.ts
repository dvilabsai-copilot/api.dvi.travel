import {
  RebuildSummary,
  RebuildWarning,
  RebuildWarningSeverity,
} from "./types";

export function buildRebuildReport(input: {
  planId: number;
  attemptedHotspotCount: number;
  scheduledHotspotCount: number;
  shiftedItems: any[];
  droppedItems: any[];
}): {
  rebuildSummary: RebuildSummary;
  warnings: RebuildWarning[];
} {
  const { planId, attemptedHotspotCount, scheduledHotspotCount, shiftedItems, droppedItems } = input;

  const warnings: RebuildWarning[] = [];

  if (droppedItems.length > 0) {
    const hasMustVisitDrop = droppedItems.some((item: any) => {
      const priority = Number(item?.priority ?? 0);
      return priority >= 1 && priority <= 3;
    });

    warnings.push({
      code: "HOTSPOT_DROPPED",
      severity: hasMustVisitDrop
        ? RebuildWarningSeverity.RED
        : RebuildWarningSeverity.ORANGE,
      message: `${droppedItems.length} hotspot(s) were dropped during rebuild.`,
    });
  }

  if (shiftedItems.length > 0) {
    warnings.push({
      code: "HOTSPOT_SHIFTED",
      severity: RebuildWarningSeverity.YELLOW,
      message: `${shiftedItems.length} hotspot(s) were shifted during rebuild.`,
    });
  }

  if (warnings.length === 0) {
    warnings.push({
      code: "REBUILD_OK",
      severity: RebuildWarningSeverity.GREEN,
      message: "Hotspot rebuild completed without timing conflicts.",
    });
  }

  const rebuildSummary: RebuildSummary = {
    planId,
    totalHotspotsAttempted: attemptedHotspotCount,
    totalHotspotsScheduled: scheduledHotspotCount,
    totalHotspotsDropped: droppedItems.length,
    totalHotspotsShifted: shiftedItems.length,
    warningCount: warnings.length,
    hasCriticalIssues: warnings.some(
      (w) => w.severity === RebuildWarningSeverity.RED,
    ),
  };

  return { rebuildSummary, warnings };
}