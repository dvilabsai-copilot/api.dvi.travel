import { RouteRejectionSummary } from './types';

export type RejectionGateBreakdown = {
  alreadyUsedOnAnotherRoute: boolean;
  outsideOperatingHours: boolean;
  routeEndDeadline: boolean;
  duplicateSuppression: boolean;
  noRemainingWindow: boolean;
  other: boolean;
};

export class TimelineRejectionPolicyService {
  private readonly summaries = new Map<number, RouteRejectionSummary>();
  private readonly routeEndBufferMinutes = Math.max(
    0,
    Number.parseInt(process.env.HOTSPOT_ROUTE_END_BUFFER_MINUTES || '0', 10) || 0,
  );
  private readonly routeEndBufferRouteIds = new Set<number>(
    String(process.env.HOTSPOT_ROUTE_END_BUFFER_ROUTE_IDS || '')
      .split(',')
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isFinite(value) && value > 0),
  );

  clear(): void {
    this.summaries.clear();
  }

  getSummaryByRoute(): Record<number, RouteRejectionSummary> {
    return Object.fromEntries(this.summaries.entries());
  }

  getRouteEndBufferSeconds(routeId: number): number {
    if (this.routeEndBufferMinutes <= 0) return 0;
    if (this.routeEndBufferRouteIds.size > 0 && !this.routeEndBufferRouteIds.has(routeId)) return 0;
    return this.routeEndBufferMinutes * 60;
  }

  classifyRejectionReason(reason: string): keyof RouteRejectionSummary {
    const normalized = String(reason || '').toLowerCase();
    if (normalized.includes('php_gate_route_end') || normalized.includes('route end')) return 'routeEnd';
    if (normalized.includes('operating hours') || normalized.includes('closed')) return 'operatingHours';
    if (normalized.includes('duplicate')) return 'duplicate';
    if (normalized.includes('no remaining day window')) return 'noRemainingWindow';
    return 'other';
  }

  buildRejectionGateBreakdown(rejectedReasons: string[]): RejectionGateBreakdown {
    const normalizedReasons = (Array.isArray(rejectedReasons) ? rejectedReasons : [])
      .map((reason) => String(reason || '').toLowerCase());
    const hasMatch = (...needles: string[]) =>
      normalizedReasons.some((reason) => needles.some((needle) => reason.includes(needle)));
    const alreadyUsedOnAnotherRoute = hasMatch('duplicate_plan_scope', 'already used on another route', 'already on another day');
    const outsideOperatingHours = hasMatch('operating hours', 'outside operating hours', 'closed on this day');
    const routeEndDeadline = hasMatch('php_gate_route_end', 'route end', 'exceeds route end');
    const duplicateSuppression = hasMatch('duplicate', 'dedup', 'de-dup');
    const noRemainingWindow = hasMatch('no remaining day window', 'no remaining window');
    return {
      alreadyUsedOnAnotherRoute,
      outsideOperatingHours,
      routeEndDeadline,
      duplicateSuppression,
      noRemainingWindow,
      other: !alreadyUsedOnAnotherRoute && !outsideOperatingHours && !routeEndDeadline && !duplicateSuppression && !noRemainingWindow,
    };
  }

  recordHotspotCandidateEvaluation(payload: {
    routeId: number;
    selected: boolean;
    rejectedReasons: string[];
  }): void {
    const routeId = Number(payload.routeId || 0);
    if (!routeId) return;
    const existing = this.summaries.get(routeId) || {
      totalRejectedCandidates: 0,
      totalSelectedCandidates: 0,
      routeEnd: 0,
      operatingHours: 0,
      duplicate: 0,
      noRemainingWindow: 0,
      other: 0,
    };
    if (payload.selected) {
      existing.totalSelectedCandidates += 1;
      this.summaries.set(routeId, existing);
      return;
    }
    if (!Array.isArray(payload.rejectedReasons) || payload.rejectedReasons.length === 0) {
      this.summaries.set(routeId, existing);
      return;
    }
    existing.totalRejectedCandidates += 1;
    const matchedCategories = new Set<keyof RouteRejectionSummary>();
    for (const reason of payload.rejectedReasons) {
      const category = this.classifyRejectionReason(reason);
      if (matchedCategories.has(category)) continue;
      matchedCategories.add(category);
      existing[category] += 1;
    }
    this.summaries.set(routeId, existing);
  }
}
