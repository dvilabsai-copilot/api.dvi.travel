import { timeToSeconds } from './time.helper';

export interface TimelineMatrixAutobuildInput {
  tx: any;
  route: any;
  plan: any;
  planId: number;
  sourceCity: string;
  destinationCity: string;
  currentTime: string;
  routeStartSeconds: number;
  routeEndSeconds: number;
  timingMap: Map<number, Map<number, any[]>>;
  hotspotMap: Map<number, any>;
  selectedHotspots: any[];
  isHotspotAlreadyPlanned: (...args: any[]) => boolean;
  getBetweenCandidatesForRouteSlots: (...args: any[]) => Promise<Map<string, any[]>>;
  logTimeline: (...args: any[]) => void;
  logBookingRule: (...args: any[]) => void;
  canonicalCityKey: (...args: any[]) => string;
  hotspotLocationMatchesCity: (...args: any[]) => boolean;
  checkHotspotOperatingHoursFromMap: (...args: any[]) => any;
}

export class TimelineMatrixAutobuildService {
  async apply(input: TimelineMatrixAutobuildInput): Promise<any[]> {
    let selectedHotspots = input.selectedHotspots;
    const {
      tx,
      route,
      plan,
      planId,
      sourceCity,
      destinationCity,
      currentTime,
      routeStartSeconds,
      routeEndSeconds,
      timingMap,
      hotspotMap,
    } = input;

          try {
            const matrixEnabled = String(process.env.HOTSPOT_MATRIX_AUTOBUILD || 'false').toLowerCase() === 'true';
            if (matrixEnabled) {
              input.logTimeline('[MATRIX_AUTOBUILD_ENABLED] routeId', route.itinerary_route_ID);
    
              // Load route's active attraction hotspots to derive slot pairs
              const routeAttractions: any[] = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
                where: { itinerary_route_ID: Number(route.itinerary_route_ID), item_type: 4, deleted: 0, status: 1 },
                orderBy: { hotspot_order: 'asc' },
                select: { hotspot_ID: true },
              });
    
              const routeHotspotIds = (routeAttractions || []).map((r: any) => Number(r.hotspot_ID || 0)).filter((id: number) => id > 0);
              const slotPairs: Array<{ fromId: number; toId: number }> = [];
              for (let i = 0; i < routeHotspotIds.length - 1; i++) {
                const a = routeHotspotIds[i];
                const b = routeHotspotIds[i + 1];
                if (a && b && a !== b) slotPairs.push({ fromId: a, toId: b });
              }
    
              if (slotPairs.length > 0) {
                const matrixMap = await input.getBetweenCandidatesForRouteSlots(tx, slotPairs);
    
                for (const slot of slotPairs) {
                  const key = `${slot.fromId}_${slot.toId}`;
                  const rows = matrixMap.get(key) || [];
                  if (!rows.length) continue;
    
                  for (const r of rows) {
                    input.logTimeline('[MATRIX] MATRIX_CANDIDATE_FOUND', { routeId: route.itinerary_route_ID, slotFrom: slot.fromId, slotTo: slot.toId, between: r.between_hotspot_id });
    
                    const fitType = String(r.route_fit_type || '').toUpperCase();
                    if (!['ON_ROUTE', 'MINOR_DETOUR'].includes(fitType)) {
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_ROUTE_FIT', { routeId: route.itinerary_route_ID, between: r.between_hotspot_id, fitType });
                      continue;
                    }
    
                    const candidateId = Number(r.between_hotspot_id || 0);
                    if (!candidateId) continue;
                    const candidateMaster = (hotspotMap.get(candidateId) || {}) as any;
                    const masterLocation = String(candidateMaster?.hotspot_location || '');
                    const masterToLocation = String(candidateMaster?.hotspot_to_location || '');
                    const masterLocationKey = input.canonicalCityKey(masterLocation);
                    const masterToLocationKey = input.canonicalCityKey(masterToLocation);
                    const isCorridorMasterHotspot = !!masterLocationKey && !!masterToLocationKey && masterLocationKey !== masterToLocationKey;
                    const corridorBelongsToCurrentRoute =
                      input.hotspotLocationMatchesCity(masterLocation, sourceCity) &&
                      input.hotspotLocationMatchesCity(masterToLocation, destinationCity);
                    if (isCorridorMasterHotspot && !corridorBelongsToCurrentRoute) {
                      if (candidateId === 228 || candidateId === 357) {
                        input.logBookingRule({
                          rule: 'BETWEEN_MAP_228_357_PROOF',
                          quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                          planId,
                          routeId: route.itinerary_route_ID,
                          fromHotspotId: slot.fromId,
                          toHotspotId: slot.toId,
                          betweenHotspotId: candidateId,
                          routeFitType: fitType,
                          currentTime,
                          accepted: false,
                          rejectedReason: 'corridor_between_hotspot_not_owned_by_current_route',
                          insertedBy: 'hotspot_route_between_map',
                        });
                      }
                      input.logBookingRule({
                        rule: 'CORRIDOR_BETWEEN_HOTSPOT_WRONG_ROUTE_BLOCKED',
                        quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                        planId,
                        routeId: route.itinerary_route_ID,
                        hotspotId: candidateId,
                        hotspotName: String(candidateMaster?.hotspot_name || ''),
                        sourceCity,
                        destinationCity,
                        masterLocation,
                        masterToLocation,
                        reason: 'corridor_between_hotspot_not_owned_by_current_route',
                      });
                      continue;
                    }
                    if (candidateId === 228 || candidateId === 357) {
                      input.logBookingRule({
                        rule: 'BETWEEN_MAP_228_357_PROOF',
                        quoteId: (plan as any).quote_id ?? (plan as any).quoteId ?? (plan as any).quote_ID ?? null,
                        planId,
                        routeId: route.itinerary_route_ID,
                        fromHotspotId: slot.fromId,
                        toHotspotId: slot.toId,
                        betweenHotspotId: candidateId,
                        routeFitType: fitType,
                        currentTime,
                        accepted: true,
                        rejectedReason: null,
                        insertedBy: 'hotspot_route_between_map',
                      });
                    }
    
                    // Respect route-level excluded_hotspot_ids if present on route
                    const localExcluded = new Set<number>(Array.isArray((route as any)?.excluded_hotspot_ids) ? ((route as any).excluded_hotspot_ids || []).map((id: any) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0) : []);
                    if (localExcluded.has(candidateId)) {
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'excluded', candidateId });
                      continue;
                    }
    
                    if (input.isHotspotAlreadyPlanned(candidateId)) {
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'already_added', candidateId });
                      continue;
                    }
    
                    const exists = selectedHotspots.some((s: any) => Number(s.hotspot_ID || 0) === candidateId);
                    if (exists) {
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_SKIPPED_DUPLICATE', { reason: 'present_in_candidates', candidateId });
                      continue;
                    }
    
                    // Build candidate object (do not override priority/explicit buckets)
                    const matrixMatchDirection = (Number(r.from_hotspot_id || 0) === slot.fromId && Number(r.to_hotspot_id || 0) === slot.toId)
                      ? 'EXACT_DIRECTION'
                      : 'REVERSE_CANONICAL_MATCH';
    
                    const candidate: any = {
                      hotspot_ID: candidateId,
                      display_order: 0,
                      hotspot_priority: 0,
                      matched_bucket: 'matrix',
                      matrix_score: 0,
                      matrix_meta: {
                        route_fit_type: fitType,
                        road_detour_km: r.road_detour_km != null ? Number(r.road_detour_km) : null,
                        road_detour_ratio: r.road_detour_ratio != null ? Number(r.road_detour_ratio) : null,
                        candidate_distance_from_ab_route_meters: r.candidate_distance_from_ab_route_meters != null ? Number(r.candidate_distance_from_ab_route_meters) : null,
                        matrixMatchDirection,
                      },
                    };
    
                    // Compute a simple matrix score: prefer ON_ROUTE strongly, MINOR_DETOUR moderately,
                    // penalize by detour ratio and distance-from-route.
                    try {
                      let score = 0;
                      if (fitType === 'ON_ROUTE') score += 100;
                      else if (fitType === 'MINOR_DETOUR') score += 25;
                      const detourRatio = candidate.matrix_meta.road_detour_ratio;
                      if (typeof detourRatio === 'number' && !Number.isNaN(detourRatio)) score -= Math.round(detourRatio * 10);
                      const distMeters = candidate.matrix_meta.candidate_distance_from_ab_route_meters;
                      if (typeof distMeters === 'number' && !Number.isNaN(distMeters)) score -= Math.round(distMeters / 1000);
                      candidate.matrix_score = score;
                    } catch (e) {
                      candidate.matrix_score = 0;
                    }
    
                    // Timing & route feasibility checks before merging candidate
                    try {
                      const hotspotData = (hotspotMap.get(candidateId) || {}) as any;
                      const hotspotDuration = String(hotspotData?.hotspot_duration || '01:00:00');
                      const durationSecs = timeToSeconds(hotspotDuration);
                      const nowSecs = Math.max(routeStartSeconds, timeToSeconds(currentTime));
                      const visitStartSecs = nowSecs;
                      const visitEndSecs = visitStartSecs + Math.max(60, durationSecs);
    
                      // Reject if visit would exceed route end deadline
                      if (visitEndSecs > routeEndSeconds) {
                        input.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_ROUTE_END', { routeId: route.itinerary_route_ID, candidateId, visitEndSecs, routeEndSeconds });
                        continue;
                      }
    
                      // If route date is available, compute php-style day-of-week and consult timingMap
                      const routeDateForMatrix = route.itinerary_route_date ? new Date(route.itinerary_route_date) : null;
                      const localPhpDow = routeDateForMatrix ? ((routeDateForMatrix.getDay() + 6) % 7) : undefined;
                      if (typeof localPhpDow === 'number') {
                        const opCheck = input.checkHotspotOperatingHoursFromMap(timingMap, candidateId, localPhpDow, visitStartSecs, visitEndSecs);
                        if (!opCheck.canVisitNow) {
                          input.logTimeline('[MATRIX] MATRIX_CANDIDATE_REJECTED_TIMING', { routeId: route.itinerary_route_ID, candidateId, nextWindowStart: opCheck.nextWindowStart });
                          continue;
                        }
                      }
    
                      // Passed checks â€” merge (append) as optional candidate
                      selectedHotspots.push(candidate);
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_MERGED', { routeId: route.itinerary_route_ID, candidateId, matrixMatchDirection, matrix_score: candidate.matrix_score });
                    } catch (e) {
                      input.logTimeline('[MATRIX] MATRIX_CANDIDATE_MERGE_ERROR', { err: String(e), candidateId });
                      continue;
                    }
                  }
                }
              }
            }
          } catch (err) {
            console.error('[MATRIX] autobuild merge error:', err);
          }
    return selectedHotspots;
  }
}
