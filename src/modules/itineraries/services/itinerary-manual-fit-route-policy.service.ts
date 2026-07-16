import { Injectable } from '@nestjs/common';
import { normalizeCityName } from '../utils/city-normalization.util';

type ManualHotspotCityContext = 'SOURCE_CITY' | 'DESTINATION_CITY' | 'UNKNOWN';

@Injectable()
export class ItineraryManualFitRoutePolicyService {

  public routeFitTypeRank(type: string): number {
    switch (type) {
      case 'ON_ROUTE': return 1;
      case 'MINOR_DETOUR': return 2;
      case 'BACKTRACK': return 3;
      case 'OFF_ROUTE': return 4;
      case 'UNKNOWN': return 5;
      case 'MATRIX_UNAVAILABLE': return 6;
      default: return 5;
    }
  }

  public routeFitLabel(type: string): string {
    switch (type) {
      case 'ON_ROUTE': return 'Fits on the way';
      case 'MINOR_DETOUR': return 'Minor detour';
      case 'BACKTRACK': return 'Backtrack warning';
      case 'OFF_ROUTE': return 'Off route';
      case 'UNKNOWN': return 'Route data missing';
      case 'MATRIX_UNAVAILABLE': return 'Matrix unavailable for hotel/source segment';
      default: return 'Route data missing';
    }
  }

  public buildRouteFitDisplayMeta(params: {
    routeFitType: string;
    roadDetourKm?: number | null;
    insertedRouteDistanceKm?: number | null;
    abOsrmDistanceKm?: number | null;
    finalDecisionReason?: string | null;
  }): {
    displayLabel: string;
    shortLabel: string;
    isZeroExtraDetour: boolean;
    distanceComparisonNote: string | null;
    finalDecisionReason: string | null;
  } {
    const routeFitType = String(params?.routeFitType || '').toUpperCase();
    const roadDetourKmRaw = params?.roadDetourKm;
    const roadDetourKm = roadDetourKmRaw != null && Number.isFinite(Number(roadDetourKmRaw))
      ? Number(roadDetourKmRaw)
      : null;
    const insertedRouteDistanceKm = params?.insertedRouteDistanceKm != null && Number.isFinite(Number(params.insertedRouteDistanceKm))
      ? Number(params.insertedRouteDistanceKm)
      : null;
    const abOsrmDistanceKm = params?.abOsrmDistanceKm != null && Number.isFinite(Number(params.abOsrmDistanceKm))
      ? Number(params.abOsrmDistanceKm)
      : null;

    let displayLabel = this.routeFitLabel(routeFitType);
    let shortLabel = displayLabel;
    let finalDecisionReason = params?.finalDecisionReason ?? null;

    const isZeroExtraDetour = roadDetourKm != null ? roadDetourKm <= 0.5 : false;
    const distanceComparisonNote =
      insertedRouteDistanceKm != null
      && abOsrmDistanceKm != null
      && insertedRouteDistanceKm < abOsrmDistanceKm
        ? 'Via route is equivalent or slightly shorter based on cached road distance.'
        : null;

    if (routeFitType === 'MINOR_DETOUR') {
      if (isZeroExtraDetour) {
        displayLabel = 'Near route / no extra distance';
        shortLabel = 'No extra distance';
        if (!finalDecisionReason || !String(finalDecisionReason).toLowerCase().startsWith('not selected')) {
          finalDecisionReason = 'This hotspot is near the route and does not add meaningful extra travel distance.';
        }
      } else {
        displayLabel = 'Minor detour';
        shortLabel = 'Minor detour';
        if (!finalDecisionReason || !String(finalDecisionReason).trim()) {
          finalDecisionReason = 'This hotspot adds a small acceptable detour.';
        }
      }
    }

    return {
      displayLabel,
      shortLabel,
      isZeroExtraDetour,
      distanceComparisonNote,
      finalDecisionReason,
    };
  }

  public isFeasibleFitType(type: string): boolean {
    return type === 'ON_ROUTE' || type === 'MINOR_DETOUR';
  }

  public isUsableMatrixRouteFitType(type: string): boolean {
    return type === 'ON_ROUTE' || type === 'MINOR_DETOUR' || type === 'BACKTRACK' || type === 'OFF_ROUTE';
  }

  public hasValidManualMatrixSlot(manualInsertionFit: any): boolean {
    const slot = manualInsertionFit?.chosenSlot;
    const bestSlot = manualInsertionFit?.bestSlot;
    const chosenSlotType = String(slot?.routeFitType || '').toUpperCase();
    const bestSlotType = String(bestSlot?.routeFitType || '').toUpperCase();
    const chosenSlotContext = String(slot?.slotContext || '').toUpperCase();
    const bestSlotContext = String(bestSlot?.slotContext || '').toUpperCase();
    const manualTimingPolicy = manualInsertionFit?.manualTimingPolicy;
    const manualRelaxedRouteFit =
      manualTimingPolicy?.mode === 'MANUAL_HOTSPOT'
      && manualTimingPolicy?.allowOffRouteWhenTimePermits === true;
    const isManualAllowedFitType = (type: string) =>
      this.isFeasibleFitType(type)
      || (
        manualRelaxedRouteFit
        && this.isUsableMatrixRouteFitType(type)
      );

    const chosenSlotValid = (
      !!slot
      && manualInsertionFit?.routeFitAvailable !== false
      && (
        (
          isManualAllowedFitType(chosenSlotType)
          && Number(slot?.fromHotspotId || 0) > 0
          && Number(slot?.toHotspotId || 0) > 0
        )
        || (
          chosenSlotType === 'SINGLE_HOTSPOT_BEFORE'
          && Number(slot?.toHotspotId || 0) > 0
        )
        || (
          chosenSlotType === 'SINGLE_HOTSPOT_AFTER'
          && Number(slot?.fromHotspotId || 0) > 0
        )
        || (
          isManualAllowedFitType(chosenSlotType)
          && manualInsertionFit?.cityEndpointInsertionMode === true
          && (
            (chosenSlotContext === 'CITY_TO_HOTSPOT' && Number(slot?.toHotspotId || 0) > 0)
            || (chosenSlotContext === 'HOTSPOT_TO_CITY' && Number(slot?.fromHotspotId || 0) > 0)
            || (
              chosenSlotContext === 'CITY_TO_CITY'
              && manualInsertionFit?.emptyRouteCityEndpointMode === true
              && Number(manualInsertionFit?.selectedHotspotId || slot?.betweenHotspotId || 0) > 0
            )
          )
        )
      )
    );

    const sourceExitAnchorBestSlotValid = (
      !!bestSlot
      && (
        String(bestSlot?.source || '') === 'SOURCE_CITY_EXIT_ANCHOR'
        || String(bestSlot?.source || '') === 'OSRM_SOURCE_CITY_ROUTE_ANCHOR'
      )
      && isManualAllowedFitType(bestSlotType)
      && Number(bestSlot?.fromHotspotId || 0) > 0
      && Number(bestSlot?.toHotspotId || 0) > 0
    );

    const singleHotspotBestSlotValid = (
      !!bestSlot
      && (
        (bestSlotType === 'SINGLE_HOTSPOT_BEFORE' && Number(bestSlot?.toHotspotId || 0) > 0)
        || (bestSlotType === 'SINGLE_HOTSPOT_AFTER' && Number(bestSlot?.fromHotspotId || 0) > 0)
        || (
          isManualAllowedFitType(bestSlotType)
          && manualInsertionFit?.cityEndpointInsertionMode === true
          && (
            (bestSlotContext === 'CITY_TO_HOTSPOT' && Number(bestSlot?.toHotspotId || 0) > 0)
            || (bestSlotContext === 'HOTSPOT_TO_CITY' && Number(bestSlot?.fromHotspotId || 0) > 0)
            || (
              bestSlotContext === 'CITY_TO_CITY'
              && manualInsertionFit?.emptyRouteCityEndpointMode === true
              && Number(manualInsertionFit?.selectedHotspotId || bestSlot?.betweenHotspotId || 0) > 0
            )
          )
        )
      )
    );

    const destinationHotelSideBestSlotValid = (
      !!bestSlot
      && String(bestSlot?.source || '') === 'DESTINATION_HOTEL_SIDE'
      && isManualAllowedFitType(bestSlotType)
      && Number(bestSlot?.fromHotspotId || 0) > 0
      && Number(manualInsertionFit?.destinationAnchorOrder || 0) > 0
    );

    return chosenSlotValid || sourceExitAnchorBestSlotValid || singleHotspotBestSlotValid || destinationHotelSideBestSlotValid;
  }

  public isEmptyRouteSchedulerEligible(manualInsertionFit: any): boolean {
    return (
      String(manualInsertionFit?.chosenSlotSource || '') === 'EMPTY_ROUTE_SCHEDULER'
      && manualInsertionFit?.emptyRouteCityEndpointMode === true
      && manualInsertionFit?.selectedIncluded === true
      && manualInsertionFit?.canApply === true
    ) || (
      manualInsertionFit?.emptyRouteCityEndpointMode === true
      && manualInsertionFit?.routeFitAvailable === true
      && manualInsertionFit?.canApply === true
      && manualInsertionFit?.selectedIncluded === true
      && manualInsertionFit?.hasFeasibleMatrixSlot !== true
    );
  }

  public buildMissingMatrixBuildSuggestion(planId: number, routeId: number, candidateHotspotId: number) {
    const normalizedPlanId = Number(planId || 0);
    const normalizedRouteId = Number(routeId || 0);
    const normalizedCandidateId = Number(candidateHotspotId || 0);

    return {
      routeId: normalizedRouteId,
      candidateHotspotId: normalizedCandidateId,
      command: `npx tsx scripts/build-missing-manual-hotspot-matrix.ts --planId ${normalizedPlanId} --routeId ${normalizedRouteId} --candidateHotspotId ${normalizedCandidateId}`,
    };
  }

  public normalizeLocationText(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const firstSegment = raw.includes('|') ? String(raw.split('|')[0] || '') : raw;
    return firstSegment.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  public deriveLooseCityKey(value: string): string {
    const normalized = this.normalizeLocationText(value || '');
    if (!normalized) return '';

    const primary = String(normalized.split(',')[0] || '').trim();
    if (!primary) return '';

    const stopwords = new Set([
      'international',
      'domestic',
      'airport',
      'station',
      'railway',
      'junction',
      'bus',
      'stand',
      'terminal',
      'city',
      'district',
      'state',
      'india',
    ]);

    const tokens = primary
      .split(' ')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .filter((t) => !stopwords.has(t));

    if (tokens.length > 0) {
      return tokens[0];
    }

    return String(primary.split(' ')[0] || '').trim();
  }

  public classifyManualHotspotCityContext(route: any, hotspot: any): ManualHotspotCityContext {
    const sourceRaw = String(route?.location_name || route?.source_location || '').trim();
    const destinationRaw = String(route?.next_visiting_location || route?.destination_location || '').trim();

    const sourceKey = this.deriveLooseCityKey(sourceRaw);
    const destinationKey = this.deriveLooseCityKey(destinationRaw);

    const hotspotLocation = String(hotspot?.hotspot_location || hotspot?.locationMap || '').trim();
    const hotspotToLocation = String(hotspot?.hotspot_to_location || hotspot?.toLocation || hotspot?.hotspotToLocation || '').trim();
    const hotspotName = String(hotspot?.hotspot_name || hotspot?.name || '').trim();

    const locationNorm = this.normalizeLocationText(hotspotLocation);
    const toLocationNorm = this.normalizeLocationText(hotspotToLocation);
    const nameNorm = this.normalizeLocationText(hotspotName);
    const locationCityNorm = normalizeCityName(hotspotLocation);
    const toLocationCityNorm = normalizeCityName(hotspotToLocation);
    const nameCityNorm = normalizeCityName(hotspotName);

    const sourceNorm = normalizeCityName(sourceRaw);
    const destinationNorm = normalizeCityName(destinationRaw);

    const matchesSource = (
      (!!sourceKey && (locationNorm.includes(sourceKey) || nameNorm.includes(sourceKey)))
      || (!!sourceNorm && (locationCityNorm === sourceNorm || nameCityNorm === sourceNorm))
    );
    const toMatchesSource = (
      (!!sourceKey && toLocationNorm.includes(sourceKey))
      || (!!sourceNorm && toLocationCityNorm === sourceNorm)
    );

    const matchesDestination = (
      (!!destinationKey && (locationNorm.includes(destinationKey) || nameNorm.includes(destinationKey)))
      || (!!destinationNorm && (locationCityNorm === destinationNorm || nameCityNorm === destinationNorm))
    );
    const toMatchesDestination = (
      (!!destinationKey && toLocationNorm.includes(destinationKey))
      || (!!destinationNorm && toLocationCityNorm === destinationNorm)
    );

    const sameCityRoute = (
      (!!sourceNorm && !!destinationNorm && sourceNorm === destinationNorm)
      || (!!sourceKey && !!destinationKey && sourceKey === destinationKey)
    );

    if (!sameCityRoute) {
      const forwardRouteMovement = (matchesSource || toMatchesSource) && toMatchesDestination;
      const reverseRouteMovement = (matchesDestination || toMatchesDestination) && toMatchesSource;

      if (forwardRouteMovement && !reverseRouteMovement) return 'DESTINATION_CITY';
      if (reverseRouteMovement && !forwardRouteMovement) return 'SOURCE_CITY';
    }

    if (sameCityRoute && matchesSource && matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination && !matchesSource) return 'DESTINATION_CITY';
    if (matchesSource && !matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination) return 'DESTINATION_CITY';
    if (matchesSource) return 'SOURCE_CITY';
    return 'UNKNOWN';
  }

  public classifyManualRouteAttractionCityContext(route: any, hotspot: any): ManualHotspotCityContext {
    const sourceRaw = String(route?.location_name || route?.source_location || '').trim();
    const destinationRaw = String(route?.next_visiting_location || route?.destination_location || '').trim();
    const hotspotLocation = String(hotspot?.hotspot_location || hotspot?.locationMap || '').trim();
    const hotspotName = String(hotspot?.hotspot_name || hotspot?.name || '').trim();

    const sourceKey = this.deriveLooseCityKey(sourceRaw);
    const destinationKey = this.deriveLooseCityKey(destinationRaw);
    const sourceNorm = normalizeCityName(sourceRaw);
    const destinationNorm = normalizeCityName(destinationRaw);
    const locationNorm = this.normalizeLocationText(hotspotLocation);
    const nameNorm = this.normalizeLocationText(hotspotName);
    const locationCityNorm = normalizeCityName(hotspotLocation);
    const nameCityNorm = normalizeCityName(hotspotName);

    const matchesSource = (
      (!!sourceKey && (locationNorm.includes(sourceKey) || nameNorm.includes(sourceKey)))
      || (!!sourceNorm && (locationCityNorm === sourceNorm || nameCityNorm === sourceNorm))
    );
    const matchesDestination = (
      (!!destinationKey && (locationNorm.includes(destinationKey) || nameNorm.includes(destinationKey)))
      || (!!destinationNorm && (locationCityNorm === destinationNorm || nameCityNorm === destinationNorm))
    );

    const sameCityRoute = (
      (!!sourceNorm && !!destinationNorm && sourceNorm === destinationNorm)
      || (!!sourceKey && !!destinationKey && sourceKey === destinationKey)
    );

    if (sameCityRoute && matchesSource && matchesDestination) return 'SOURCE_CITY';
    if (matchesDestination && !matchesSource) return 'DESTINATION_CITY';
    if (matchesSource && !matchesDestination) return 'SOURCE_CITY';

    return this.classifyManualHotspotCityContext(route, hotspot);
  }

}
