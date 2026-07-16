// FILE: src/modules/itineraries/services/itinerary-manual-fit-travel-replica.service.ts

import { Injectable } from '@nestjs/common';
import { haversineKm } from '../utils/distance-utils';

type ManualFitTravelReplicaCallbacks = Record<string, (...args: any[]) => any>;

@Injectable()
export class ItineraryManualFitTravelReplicaService {
  private callbacks: ManualFitTravelReplicaCallbacks = {};

  setCallbacks(callbacks: ManualFitTravelReplicaCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public buildManualFitTravelReplicaDisplayFields(
    sourceRow: any,
    durationMin: number,
    distanceKm: number | null,
  ): {
    duration: string;
    travelDuration: string;
    durationMinutes: number;
    matrixDurationMin: number;
    distance: string | null;
    hotspot_travelling_distance: string | null;
    hotspot_traveling_distance: string | null;
    hotspot_travelling_time: string | null;
    hotspot_traveling_time: string | null;
  } {
    const parseDurationCandidateMinutes = (value: any): number | null => {
      const raw = String(value || '').trim();
      if (!raw) return null;

      const hmsMatch = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (hmsMatch) {
        const hours = Number(hmsMatch[1] || 0);
        const minutes = Number(hmsMatch[2] || 0);
        if (Number.isFinite(hours) && Number.isFinite(minutes)) {
          return (hours * 60) + minutes;
        }
      }

      const durationMatch = raw.match(/^(?:(\d+)\s*Hours?)?\s*(?:(\d+)\s*Min(?:ute)?s?)?$/i);
      if (durationMatch && (durationMatch[1] || durationMatch[2])) {
        const hours = Number(durationMatch[1] || 0);
        const minutes = Number(durationMatch[2] || 0);
        if (Number.isFinite(hours) && Number.isFinite(minutes)) {
          return (hours * 60) + minutes;
        }
      }

      const isoDate = new Date(raw);
      if (!Number.isNaN(isoDate.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(raw)) {
        return (isoDate.getUTCHours() * 60) + isoDate.getUTCMinutes();
      }

      const localDateLabelMatch = raw.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
      if (
        localDateLabelMatch &&
        /(?:sun|mon|tue|wed|thu|fri|sat)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(raw)
      ) {
        const hours = Number(localDateLabelMatch[1] || 0);
        const minutes = Number(localDateLabelMatch[2] || 0);
        if (Number.isFinite(hours) && Number.isFinite(minutes)) {
          return (hours * 60) + minutes;
        }
      }

      return null;
    };

    const durationCandidates = [
      sourceRow?.duration,
      sourceRow?.travelDuration,
      sourceRow?.hotspot_travelling_time,
      sourceRow?.hotspot_traveling_time,
    ];
    const durationText = durationCandidates
      .map((value: any) => {
        const raw = String(value || '').trim();
        if (!raw) return '';

        const parsedMinutes = parseDurationCandidateMinutes(raw);
        if (parsedMinutes === null) return '';
        if (Math.abs(parsedMinutes - durationMin) > 1) return '';

        return this.callbacks.formatPreviewTravelDuration(parsedMinutes);
      })
      .find((value) => String(value || '').trim().length > 0) || this.callbacks.formatPreviewTravelDuration(durationMin);

    const distanceCandidates = [
      sourceRow?.distance,
      sourceRow?.hotspot_travelling_distance,
      sourceRow?.hotspot_traveling_distance,
    ];
    const distanceText = distanceCandidates
      .map((value: any) => String(value || '').trim())
      .find((value) => value.length > 0 && value !== '--') || (distanceKm != null ? `${Number(distanceKm).toFixed(2)} KM` : '');

    const hotspotDistanceText = distanceCandidates
      .map((value: any) => String(value || '').trim())
      .find((value) => value.length > 0 && value !== '--') || (distanceKm != null ? Number(distanceKm).toFixed(2) : '');

    return {
      duration: durationText,
      travelDuration: durationText,
      durationMinutes: durationMin,
      matrixDurationMin: durationMin,
      distance: distanceText || null,
      hotspot_travelling_distance: hotspotDistanceText || null,
      hotspot_traveling_distance: hotspotDistanceText || null,
      hotspot_travelling_time: durationText,
      hotspot_traveling_time: durationText,
    };
  }

  private async ensurePreviewTimelineHasComputedHotelTravel(
    tx: any,
    planId: number,
    routeId: number,
    previewTimeline: any[],
  ): Promise<any[]> {
    if (!tx || !Array.isArray(previewTimeline) || previewTimeline.length === 0) {
      return Array.isArray(previewTimeline) ? previewTimeline : [];
    }

    const timeline = previewTimeline.map((row: any) => ({ ...row }));

    const isCheckinRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      const text = String(row?.text || row?.name || '').toLowerCase();
      return type === 'hotel' || type === 'checkin' || itemType === 6 || text.includes('check-in at');
    };

    const isAttractionRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      return type === 'attraction' || Number(row?.item_type || 0) === 4;
    };

    const isTravelRow = (row: any): boolean => {
      const type = String(row?.type || '').toLowerCase();
      const itemType = Number(row?.item_type || 0);
      return type === 'travel' || itemType === 3 || itemType === 5 || itemType === 7;
    };

    const normalizeLabel = (value: unknown): string =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    const lastCheckinIndex = (() => {
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        if (isCheckinRow(timeline[index])) return index;
      }
      return -1;
    })();

    if (lastCheckinIndex < 0) return timeline;

    const originalCheckinRow = timeline[lastCheckinIndex];
    const hotelNameHint = this.callbacks.extractPreviewCheckinHotelName(originalCheckinRow);
    const normalizedHotelNameHint = normalizeLabel(hotelNameHint);

    const anchorIndex = (() => {
      const anchorSearchLimit = lastCheckinIndex;
      for (let index = anchorSearchLimit - 1; index >= 0; index -= 1) {
        if (isAttractionRow(timeline[index])) return index;
      }
      return -1;
    })();

    if (anchorIndex < 0) return timeline;

    const anchorRow = timeline[anchorIndex];
    const anchorHotspotId = Number(
      anchorRow?.locationId ||
      anchorRow?.hotspot_ID ||
      anchorRow?.hotspotId ||
      anchorRow?.hotspot_id ||
      0,
    );

    if (!(anchorHotspotId > 0)) return timeline;

    const savedHotelLeg = await this.callbacks.resolveSavedRuleHotspotToRouteHotelLeg(
      tx,
      Number(planId),
      Number(routeId),
      anchorHotspotId,
    );

    if (!savedHotelLeg) return timeline;

    const hotelLabel = String(hotelNameHint || savedHotelLeg.hotelLabel || 'Hotel').trim();
    const normalizedHotelLabel = normalizeLabel(hotelLabel);
    const previousTravelIndex = (() => {
      for (let index = lastCheckinIndex - 1; index >= 0; index -= 1) {
        const row = timeline[index];
        if (!isTravelRow(row)) continue;

        const target = normalizeLabel(
          row?.toName ||
          row?.to ||
          row?.displayToName ||
          row?.text ||
          row?.name,
        );

        if (
          Number(row?.item_type || 0) === 5
          || target.includes('travel to hotel')
          || target.includes(normalizedHotelLabel)
          || target === 'hotel'
          || (normalizedHotelNameHint && target.includes(normalizedHotelNameHint))
        ) {
          return index;
        }
      }
      return -1;
    })();

    const durationMin =
      savedHotelLeg.durationMin != null && Number.isFinite(Number(savedHotelLeg.durationMin))
        ? Math.max(1, Math.round(Number(savedHotelLeg.durationMin)))
        : null;

    if (!durationMin || !Number.isFinite(durationMin)) return timeline;

    const anchorEndMinutes = this.callbacks.parseSegmentEndMinutes(anchorRow);
    if (anchorEndMinutes === null) return timeline;

    const travelStartMin = anchorEndMinutes;
    const travelEndMin = travelStartMin + durationMin;
    const distanceKm =
      savedHotelLeg.distanceKm != null && Number.isFinite(Number(savedHotelLeg.distanceKm))
        ? Number(savedHotelLeg.distanceKm)
        : null;
    const distanceLabel = distanceKm != null ? `${distanceKm.toFixed(2)} km` : '';
    const anchorLabel = String(
      anchorRow?.text ||
      anchorRow?.name ||
      anchorRow?.title ||
      `Hotspot #${anchorHotspotId}`,
    ).trim();

    const computedTravelRow = {
      ...(previousTravelIndex >= 0 ? timeline[previousTravelIndex] : {}),
      type: 'travel',
      item_type: 5,
      text: `Travel to ${hotelLabel}`,
      name: `Travel to ${hotelLabel}`,
      fromName: savedHotelLeg.fromName || anchorLabel,
      toName: hotelLabel,
      from: savedHotelLeg.fromName || anchorLabel,
      to: hotelLabel,
      displayFromName: savedHotelLeg.fromName || anchorLabel,
      displayToName: hotelLabel,
      timeRange: this.callbacks.minutesRangeToTimeString(travelStartMin, travelEndMin),
      duration: this.callbacks.formatPreviewTravelDuration(durationMin),
      travelDuration: this.callbacks.formatPreviewTravelDuration(durationMin),
      matrixDurationMin: durationMin,
      hotspot_travelling_distance: distanceKm != null ? distanceKm.toFixed(2) : null,
      distance: distanceLabel,
      distanceKm,
      travelDistanceKm: distanceKm,
      matrixDistanceKm: distanceKm,
      hotspot_start_time: null,
      hotspot_end_time: null,
      isSyntheticHotelTravel: false,
      isComputedHotelTravel: true,
    };

    const computedCheckinRow = {
      ...originalCheckinRow,
      type: 'checkin',
      item_type: 6,
      hotelName: hotelLabel,
      name: `Check-in at ${hotelLabel}`,
      text: `Check-in at ${hotelLabel}`,
      toName: hotelLabel,
      to: hotelLabel,
      time: this.callbacks.minutesRangeToTimeString(travelEndMin, travelEndMin),
      timeRange: this.callbacks.minutesRangeToTimeString(travelEndMin, travelEndMin),
      hotspot_start_time: null,
      hotspot_end_time: null,
    };

    if (previousTravelIndex >= 0) {
      timeline[previousTravelIndex] = computedTravelRow;
      timeline[lastCheckinIndex] = computedCheckinRow;
      return this.callbacks.finalizeMatrixPreviewTimeline(timeline);
    }

    timeline.splice(lastCheckinIndex, 0, computedTravelRow);
    timeline[lastCheckinIndex + 1] = computedCheckinRow;
    return this.callbacks.finalizeMatrixPreviewTimeline(timeline);
  }

  public async resolveRouteSourceEndpoint(
    tx: any,
    routeId: number,
  ): Promise<{ sourceName: string; latitude: number; longitude: number } | null> {
    const route = await (tx as any).dvi_itinerary_route_details.findFirst({
      where: {
        itinerary_route_ID: Number(routeId),
        deleted: 0,
      },
      select: {
        location_id: true,
        location_name: true,
      },
    });

    const locationId = Number(route?.location_id || 0);
    const routeSourceName = String(route?.location_name || '').trim();

    if (!locationId) {
      return routeSourceName ? { sourceName: routeSourceName, latitude: NaN, longitude: NaN } : null;
    }

    const stored = await (tx as any).dvi_stored_locations.findFirst({
      where: {
        location_ID: locationId,
        deleted: 0,
      },
      select: {
        source_location: true,
        source_location_lattitude: true,
        source_location_longitude: true,
      },
    });

    const sourceName = String(stored?.source_location || routeSourceName || '').trim();
    const latitude = Number(stored?.source_location_lattitude);
    const longitude = Number(stored?.source_location_longitude);

    if (!sourceName) return null;

    return {
      sourceName,
      latitude,
      longitude,
    };
  }

  public async resolveSourceToHotspotLeg(
    tx: any,
    routeId: number,
    hotspotId: number,
  ): Promise<{ distanceKm: number | null; durationMin: number | null; osrmUsed: boolean; sourceName: string | null }> {
    const source = await this.resolveRouteSourceEndpoint(tx, Number(routeId));
    if (!source?.sourceName) {
      return { distanceKm: null, durationMin: null, osrmUsed: false, sourceName: null };
    }

    const hotspot = await (tx as any).dvi_hotspot_place.findFirst({
      where: {
        hotspot_ID: Number(hotspotId),
        deleted: 0,
      },
      select: {
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    const toLat = Number(hotspot?.hotspot_latitude);
    const toLng = Number(hotspot?.hotspot_longitude);
    const fromLat = Number(source?.latitude);
    const fromLng = Number(source?.longitude);

    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng) || !Number.isFinite(toLat) || !Number.isFinite(toLng)) {
      return {
        distanceKm: null,
        durationMin: null,
        osrmUsed: false,
        sourceName: source.sourceName,
      };
    }

    const osrmRoute = await this.callbacks.getOsrmRouteGeometry(
      fromLat,
      fromLng,
      toLat,
      toLng,
    );

    if (osrmRoute && Number.isFinite(Number(osrmRoute.distanceKm))) {
      return {
        distanceKm: osrmRoute.distanceKm != null ? Number(osrmRoute.distanceKm) : null,
        durationMin: osrmRoute.durationMin != null ? Number(osrmRoute.durationMin) : this.callbacks.estimateDurationFromDistance(osrmRoute.distanceKm ?? null),
        osrmUsed: true,
        sourceName: source.sourceName,
      };
    }

    const fallbackDistanceKm = haversineKm(fromLat, fromLng, toLat, toLng);
    return {
      distanceKm: Number.isFinite(Number(fallbackDistanceKm)) ? Number(fallbackDistanceKm) : null,
      durationMin: this.callbacks.estimateDurationFromDistance(Number.isFinite(Number(fallbackDistanceKm)) ? Number(fallbackDistanceKm) : null),
      osrmUsed: false,
      sourceName: source.sourceName,
    };
  }

  public async ensureHotspotHotelBetweenMapTable(tx: any): Promise<void> {
    await (tx as any).$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS hotspot_hotel_between_map (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        itinerary_plan_id BIGINT NULL,
        itinerary_route_id BIGINT NULL,
        from_hotspot_id BIGINT UNSIGNED NOT NULL,
        hotel_id BIGINT UNSIGNED NOT NULL,
        between_hotspot_id BIGINT UNSIGNED NOT NULL,
        route_fit_type VARCHAR(64) NULL,
        route_decision_reason TEXT NULL,
        ab_osrm_distance_km DECIMAL(12,3) NULL,
        ac_osrm_distance_km DECIMAL(12,3) NULL,
        cb_osrm_distance_km DECIMAL(12,3) NULL,
        inserted_route_distance_km DECIMAL(12,3) NULL,
        road_detour_km DECIMAL(12,3) NULL,
        osrm_used TINYINT(1) NOT NULL DEFAULT 0,
        status TINYINT NOT NULL DEFAULT 1,
        deleted TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_hotel_between (from_hotspot_id, hotel_id, between_hotspot_id),
        KEY idx_plan_route (itinerary_plan_id, itinerary_route_id),
        KEY idx_hotel (hotel_id),
        KEY idx_between (between_hotspot_id)
      )
    `);
  }

  private async upsertHotspotHotelBetweenMapRow(
    tx: any,
    payload: {
      planId: number;
      routeId: number;
      fromHotspotId: number;
      hotelId: number;
      betweenHotspotId: number;
      routeFitType: string;
      routeDecisionReason: string;
      abDistanceKm: number | null;
      acDistanceKm: number | null;
      cbDistanceKm: number | null;
      insertedDistanceKm: number | null;
      roadDetourKm: number | null;
      osrmUsed: boolean;
    },
  ): Promise<void> {
    await this.ensureHotspotHotelBetweenMapTable(tx);
    await (tx as any).$executeRawUnsafe(
      `
      INSERT INTO hotspot_hotel_between_map (
        itinerary_plan_id,
        itinerary_route_id,
        from_hotspot_id,
        hotel_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        road_detour_km,
        osrm_used,
        status,
        deleted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
      ON DUPLICATE KEY UPDATE
        itinerary_plan_id = VALUES(itinerary_plan_id),
        itinerary_route_id = VALUES(itinerary_route_id),
        route_fit_type = VALUES(route_fit_type),
        route_decision_reason = VALUES(route_decision_reason),
        ab_osrm_distance_km = VALUES(ab_osrm_distance_km),
        ac_osrm_distance_km = VALUES(ac_osrm_distance_km),
        cb_osrm_distance_km = VALUES(cb_osrm_distance_km),
        inserted_route_distance_km = VALUES(inserted_route_distance_km),
        road_detour_km = VALUES(road_detour_km),
        osrm_used = VALUES(osrm_used),
        status = 1,
        deleted = 0
      `,
      Number(payload.planId),
      Number(payload.routeId),
      Number(payload.fromHotspotId),
      Number(payload.hotelId),
      Number(payload.betweenHotspotId),
      String(payload.routeFitType || 'DESTINATION_SIDE_INSERTION'),
      String(payload.routeDecisionReason || ''),
      payload.abDistanceKm != null ? Number(payload.abDistanceKm) : null,
      payload.acDistanceKm != null ? Number(payload.acDistanceKm) : null,
      payload.cbDistanceKm != null ? Number(payload.cbDistanceKm) : null,
      payload.insertedDistanceKm != null ? Number(payload.insertedDistanceKm) : null,
      payload.roadDetourKm != null ? Number(payload.roadDetourKm) : null,
      payload.osrmUsed ? 1 : 0,
    );
  }

  public async getOsrmDistanceKm(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
  ): Promise<number | null> {
    const route = await this.callbacks.getOsrmRouteGeometry(fromLat, fromLng, toLat, toLng);
    const distanceKm = Number(route?.distanceKm);
    return Number.isFinite(distanceKm) && distanceKm >= 0 ? distanceKm : null;
  }

}
