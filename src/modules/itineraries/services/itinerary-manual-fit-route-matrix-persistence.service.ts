import { Injectable } from '@nestjs/common';

type RouteMatrixPersistenceCallbacks = {
  findNearestProgressOnRoute?: (...args: any[]) => any;
  normalizeLocationText?: (...args: any[]) => string;
  haversineKmForRouteProjection?: (...args: any[]) => number;
  getOsrmRouteGeometry?: (...args: any[]) => Promise<any>;
  getOsrmDistanceKm?: (...args: any[]) => Promise<number | null>;
  deriveLooseCityKey?: (...args: any[]) => string;
};

@Injectable()
export class ItineraryManualFitRouteMatrixPersistenceService {
  private callbacks: RouteMatrixPersistenceCallbacks = {};

  setCallbacks(callbacks: RouteMatrixPersistenceCallbacks): void {
    this.callbacks = callbacks;
  }

  private findNearestProgressOnRoute(...args: any[]): any {
    return this.callbacks.findNearestProgressOnRoute?.(...args);
  }

  private normalizeLocationText(...args: any[]): string {
    return String(this.callbacks.normalizeLocationText?.(...args) || '');
  }

  private haversineKmForRouteProjection(...args: any[]): number {
    return Number(this.callbacks.haversineKmForRouteProjection?.(...args) || 0);
  }

  private getOsrmRouteGeometry(...args: any[]): Promise<any> {
    return this.callbacks.getOsrmRouteGeometry?.(...args) as Promise<any>;
  }

  private getOsrmDistanceKm(...args: any[]): Promise<number | null> {
    return this.callbacks.getOsrmDistanceKm?.(...args) as Promise<number | null>;
  }

  private deriveLooseCityKey(...args: any[]): string {
    return String(this.callbacks.deriveLooseCityKey?.(...args) || '');
  }


  public distancePointToRouteMeters(
    point: { lat: number; lng: number },
    routeGeometry: [number, number][],
  ): number {
    return Number(this.findNearestProgressOnRoute(point, routeGeometry).distanceMeters);
  }

  public projectPointProgressOnRoute(
    point: { lat: number; lng: number },
    routeGeometry: [number, number][],
  ): number {
    return Number(this.findNearestProgressOnRoute(point, routeGeometry).progressRatio);
  }

  public async ensureHotspotPlace(
    tx: any,
    data: {
      hotspotId?: number;
      hotspotName: string;
      hotspotLocation: string;
      lat?: number | null;
      lng?: number | null;
      createdBy?: number;
    },
  ): Promise<number | null> {
    const requestedHotspotId = Number(data?.hotspotId || 0);
    const normalizedName = this.normalizeLocationText(data?.hotspotName || '');
    const normalizedLocation = this.normalizeLocationText(data?.hotspotLocation || '');
    const lat = Number(data?.lat);
    const lng = Number(data?.lng);

    if (requestedHotspotId > 0) {
      const existingById = await (tx as any).dvi_hotspot_place.findFirst({
        where: { hotspot_ID: requestedHotspotId, deleted: 0 },
        select: { hotspot_ID: true },
      });
      if (existingById) {
 console.log('[HotspotPlaceEnsure] existing_found', { hotspotId: requestedHotspotId, mode: 'id' });
        return Number(existingById.hotspot_ID);
      }
    }

    const candidates: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT hotspot_ID, hotspot_name, hotspot_location, hotspot_latitude, hotspot_longitude
      FROM dvi_hotspot_place
      WHERE deleted = 0
        AND LOWER(COALESCE(hotspot_name, '')) = ?
        AND LOWER(COALESCE(hotspot_location, '')) LIKE ?
      LIMIT 20
      `,
      normalizedName,
      `%${normalizedLocation || normalizedName}%`,
    );

    if (Array.isArray(candidates) && candidates.length > 0) {
      const maxMatchMeters = 200;
      const exact = candidates.find((row: any) => {
        const rowId = Number(row?.hotspot_ID || 0);
        if (!rowId) return false;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
        const rowLat = Number(row?.hotspot_latitude);
        const rowLng = Number(row?.hotspot_longitude);
        if (!Number.isFinite(rowLat) || !Number.isFinite(rowLng)) return false;
        const distMeters = this.haversineKmForRouteProjection(lat, lng, rowLat, rowLng) * 1000;
        return distMeters <= maxMatchMeters;
      });

      const matched = exact || candidates[0];
      const matchedId = Number(matched?.hotspot_ID || 0);
      if (matchedId > 0) {
 console.log('[HotspotPlaceEnsure] existing_found', { hotspotId: matchedId, mode: 'name_location' });
        return matchedId;
      }
    }

    const now = new Date();
    const inserted = await (tx as any).dvi_hotspot_place.create({
      data: {
        hotspot_name: String(data?.hotspotName || '').trim() || null,
        hotspot_location: String(data?.hotspotLocation || '').trim() || null,
        hotspot_latitude: Number.isFinite(lat) ? String(lat) : null,
        hotspot_longitude: Number.isFinite(lng) ? String(lng) : null,
        status: 1,
        deleted: 0,
        createdby: Number(data?.createdBy || 0),
        createdon: now,
        updatedon: now,
      },
      select: { hotspot_ID: true },
    });

    const insertedId = Number(inserted?.hotspot_ID || 0);
    if (insertedId > 0) {
 console.log('[HotspotPlaceEnsure] inserted_new', { hotspotId: insertedId });
      return insertedId;
    }

    return null;
  }

  public async ensureRouteBetweenMapRow(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
    betweenHotspotId: number,
  ): Promise<any | null> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    const betweenId = Number(betweenHotspotId || 0);
    if (!fromId || !toId || !betweenId) {
 console.log('[RouteBetweenMapEnsure] skipped_no_hotspot_id', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const existingRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        candidate_distance_from_ab_route_meters,
        destination_distance_from_ac_route_meters
      FROM hotspot_route_between_map
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    if (Array.isArray(existingRows) && existingRows.length > 0) {
 console.log('[RouteBetweenMapEnsure] existing_found', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return existingRows[0];
    }

    const masters: any[] = await (tx as any).dvi_hotspot_place.findMany({
      where: {
        hotspot_ID: { in: [fromId, toId, betweenId] },
        deleted: 0,
      },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });

    const masterMap = new Map<number, any>((masters || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]));
    const from = masterMap.get(fromId);
    const to = masterMap.get(toId);
    const between = masterMap.get(betweenId);

    const fromLat = Number(from?.hotspot_latitude);
    const fromLng = Number(from?.hotspot_longitude);
    const toLat = Number(to?.hotspot_latitude);
    const toLng = Number(to?.hotspot_longitude);
    const betweenLat = Number(between?.hotspot_latitude);
    const betweenLng = Number(between?.hotspot_longitude);

    if (
      !from || !to || !between
      || !Number.isFinite(fromLat) || !Number.isFinite(fromLng)
      || !Number.isFinite(toLat) || !Number.isFinite(toLng)
      || !Number.isFinite(betweenLat) || !Number.isFinite(betweenLng)
    ) {
 console.warn('[RouteBetweenMapEnsure] invalid_coordinates', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const directRoute = await this.getOsrmRouteGeometry(fromLat, fromLng, toLat, toLng);
    if (!directRoute || directRoute.coordinates.length < 2) {
 console.warn('[RouteBetweenMapEnsure] osrm_failed', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const directKm = Number(directRoute.distanceKm);
    const acKm = await this.getOsrmDistanceKm(fromLat, fromLng, betweenLat, betweenLng);
    const cbKm = await this.getOsrmDistanceKm(betweenLat, betweenLng, toLat, toLng);
    if (!Number.isFinite(directKm) || !Number.isFinite(acKm) || !Number.isFinite(cbKm)) {
 console.warn('[RouteBetweenMapEnsure] osrm_failed', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
      });
      return null;
    }

    const insertedRouteDistanceKm = Number(acKm) + Number(cbKm);
    const roadDetourKm = insertedRouteDistanceKm - Number(directKm);
    const roadDetourRatio = Number(directKm) > 0 ? roadDetourKm / Number(directKm) : null;
    const candidateDistanceFromRouteMeters = this.distancePointToRouteMeters(
      { lat: betweenLat, lng: betweenLng },
      directRoute.coordinates,
    );
    const candidateProgressOnAbRatio = this.projectPointProgressOnRoute(
      { lat: betweenLat, lng: betweenLng },
      directRoute.coordinates,
    );

    let routeFitType = 'MAJOR_DETOUR';
    if (candidateDistanceFromRouteMeters <= 1000 || roadDetourKm <= 2) {
      routeFitType = 'ON_ROUTE';
    } else if (roadDetourKm <= 10) {
      routeFitType = 'MINOR_DETOUR';
    }

    const routeDecisionReason =
      routeFitType === 'ON_ROUTE'
        ? 'Candidate is on/near OSRM route with low detour.'
        : routeFitType === 'MINOR_DETOUR'
          ? 'Candidate requires acceptable minor OSRM detour.'
          : 'Candidate causes major OSRM detour.';

    if (routeFitType === 'MAJOR_DETOUR') {
 console.log('[RouteBetweenMapEnsure] rejected_major_detour', {
        fromHotspotId: fromId,
        toHotspotId: toId,
        betweenHotspotId: betweenId,
        roadDetourKm: Number(roadDetourKm.toFixed(3)),
      });
    }

    await (tx as any).$executeRawUnsafe(
      `
      INSERT INTO hotspot_route_between_map (
        from_hotspot_id,
        from_hotspot_name,
        from_hotspot_location,
        to_hotspot_id,
        to_hotspot_name,
        to_hotspot_location,
        between_hotspot_id,
        between_hotspot_name,
        distance_from_route_meters,
        detour_km,
        detour_ratio,
        route_fit_type,
        candidate_distance_from_ab_route_meters,
        candidate_progress_on_ab_ratio,
        destination_distance_from_ac_route_meters,
        destination_progress_on_ac_ratio,
        crosses_destination_before_candidate,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        road_detour_km,
        road_detour_ratio,
        route_decision_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        route_fit_type = VALUES(route_fit_type),
        route_decision_reason = VALUES(route_decision_reason),
        distance_from_route_meters = VALUES(distance_from_route_meters),
        detour_km = VALUES(detour_km),
        detour_ratio = VALUES(detour_ratio),
        candidate_distance_from_ab_route_meters = VALUES(candidate_distance_from_ab_route_meters),
        candidate_progress_on_ab_ratio = VALUES(candidate_progress_on_ab_ratio),
        ab_osrm_distance_km = VALUES(ab_osrm_distance_km),
        ac_osrm_distance_km = VALUES(ac_osrm_distance_km),
        cb_osrm_distance_km = VALUES(cb_osrm_distance_km),
        inserted_route_distance_km = VALUES(inserted_route_distance_km),
        road_detour_km = VALUES(road_detour_km),
        road_detour_ratio = VALUES(road_detour_ratio),
        updated_at = NOW()
      `,
      fromId,
      String(from?.hotspot_name || `Hotspot #${fromId}`),
      String(from?.hotspot_location || ''),
      toId,
      String(to?.hotspot_name || `Hotspot #${toId}`),
      String(to?.hotspot_location || ''),
      betweenId,
      String(between?.hotspot_name || `Hotspot #${betweenId}`),
      candidateDistanceFromRouteMeters,
      roadDetourKm,
      roadDetourRatio,
      routeFitType,
      candidateDistanceFromRouteMeters,
      candidateProgressOnAbRatio,
      null,
      null,
      Number(directKm),
      Number(acKm),
      Number(cbKm),
      insertedRouteDistanceKm,
      roadDetourKm,
      roadDetourRatio,
      routeDecisionReason,
    );

    const insertedRows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        route_fit_type,
        route_decision_reason,
        road_detour_km,
        road_detour_ratio,
        ab_osrm_distance_km,
        ac_osrm_distance_km,
        cb_osrm_distance_km,
        inserted_route_distance_km,
        candidate_distance_from_ab_route_meters,
        destination_distance_from_ac_route_meters
      FROM hotspot_route_between_map
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    const insertedRow = Array.isArray(insertedRows) && insertedRows.length > 0 ? insertedRows[0] : null;
 console.log('[RouteBetweenMapEnsure] inserted_new', {
      fromHotspotId: fromId,
      toHotspotId: toId,
      betweenHotspotId: betweenId,
      routeFitType,
    });
    return insertedRow;
  }

  public async getRouteBetweenRejectionRow(
    tx: any,
    fromHotspotId: number,
    toHotspotId: number,
    betweenHotspotId: number,
  ): Promise<any | null> {
    const fromId = Number(fromHotspotId || 0);
    const toId = Number(toHotspotId || 0);
    const betweenId = Number(betweenHotspotId || 0);
    if (!fromId || !toId || !betweenId) {
      return null;
    }

    const rows: any[] = await (tx as any).$queryRawUnsafe(
      `
      SELECT
        from_hotspot_id,
        to_hotspot_id,
        between_hotspot_id,
        rejection_code,
        rejection_reason,
        route_fit_type,
        candidate_distance_from_ab_route_meters,
        road_detour_km,
        road_detour_ratio,
        error_message
      FROM hotspot_route_between_rejections
      WHERE (
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
        OR
        (from_hotspot_id = ? AND to_hotspot_id = ? AND between_hotspot_id = ?)
      )
      LIMIT 1
      `,
      fromId,
      toId,
      betweenId,
      toId,
      fromId,
      betweenId,
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }

    return rows[0];
  }

  public async findLastSourceCityHotspotOnOsrmRoute(
    tx: any,
    params: {
      routeId: number;
      sourceCityKey: string;
      destinationCityKey: string;
      candidateHotspotId: number;
      debug?: boolean;
    },
  ): Promise<{
    sourceAnchorHotspotId: number;
    sourceAnchorName: string;
    sourceAnchorDistanceFromRouteMeters: number;
    sourceAnchorProgressRatio: number;
    nextRouteHotspotId: number;
    osrmFailed: boolean;
    candidateDistanceFromRouteMeters: number | null;
    anchorSelectionWhy?: string;
    anchorSelectionDebug?: any;
  } | null> {
    const routeId = Number(params?.routeId || 0);
    const candidateHotspotId = Number(params?.candidateHotspotId || 0);
    const sourceCityKey = this.deriveLooseCityKey(params?.sourceCityKey || '');
    const destinationCityKey = this.deriveLooseCityKey(params?.destinationCityKey || '');
    const debug = params?.debug === true;
    if (!routeId || !candidateHotspotId) {
      return null;
    }

    const routeRows: any[] = await (tx as any).dvi_itinerary_route_hotspot_details.findMany({
      where: {
        itinerary_route_ID: routeId,
        item_type: 4,
        deleted: 0,
        status: 1,
      },
      orderBy: { hotspot_order: 'asc' },
      select: {
        hotspot_ID: true,
        hotspot_order: true,
      },
    });

    const routeHotspotIds = (routeRows || []).map((row: any) => Number(row?.hotspot_ID || 0)).filter((id: number) => id > 0);
    if (routeHotspotIds.length < 2) {
      return null;
    }

    const hotspotRows: any[] = await (tx as any).dvi_hotspot_place.findMany({
      where: { hotspot_ID: { in: routeHotspotIds.concat([candidateHotspotId]) }, deleted: 0 },
      select: {
        hotspot_ID: true,
        hotspot_name: true,
        hotspot_location: true,
        hotspot_latitude: true,
        hotspot_longitude: true,
      },
    });
    const hotspotMap = new Map<number, any>((hotspotRows || []).map((row: any) => [Number(row?.hotspot_ID || 0), row]));

    if (debug) {
      const routeDebugRows = (routeRows || []).map((rr: any) => {
        const hp = hotspotMap.get(Number(rr?.hotspot_ID || 0));
        return {
          hotspot_ID: Number(rr?.hotspot_ID || 0),
          hotspot_name: String(hp?.hotspot_name || ''),
          hotspot_location: String(hp?.hotspot_location || ''),
          latitude: Number(hp?.hotspot_latitude),
          longitude: Number(hp?.hotspot_longitude),
          hotspot_order: Number(rr?.hotspot_order || 0),
        };
      });
 console.log('[OSRMSourceRoute][AnchorSelectionDebug] active_route_hotspots_loaded', {
        routeId,
        hotspots: routeDebugRows,
      });
    }

    const orderedExisting = routeHotspotIds
      .map((id: number) => ({ id, row: hotspotMap.get(id) }))
      .filter((item: any) => {
        const lat = Number(item?.row?.hotspot_latitude);
        const lng = Number(item?.row?.hotspot_longitude);
        return Number.isFinite(lat) && Number.isFinite(lng);
      });

    if (orderedExisting.length < 2) {
 console.warn('[ManualMatrixEnsure] invalid_coordinates', { routeId, reason: 'No valid route endpoint coordinates.' });
      return null;
    }

    const start = orderedExisting[0];
    const end = orderedExisting[orderedExisting.length - 1];
    const startLat = Number(start.row?.hotspot_latitude);
    const startLng = Number(start.row?.hotspot_longitude);
    const endLat = Number(end.row?.hotspot_latitude);
    const endLng = Number(end.row?.hotspot_longitude);

    const routeGeometry = await this.getOsrmRouteGeometry(startLat, startLng, endLat, endLng);
    if (!routeGeometry || routeGeometry.coordinates.length < 2) {
 console.warn('[ManualMatrixEnsure] osrm_failed', { routeId, fromHotspotId: start.id, toHotspotId: end.id });
      return {
        sourceAnchorHotspotId: start.id,
        sourceAnchorName: String(start.row?.hotspot_name || `Hotspot #${start.id}`),
        sourceAnchorDistanceFromRouteMeters: 0,
        sourceAnchorProgressRatio: 0,
        nextRouteHotspotId: Number(orderedExisting[1]?.id || 0),
        osrmFailed: true,
        candidateDistanceFromRouteMeters: null,
        anchorSelectionWhy: debug ? 'OSRM route geometry unavailable; fallback anchor could not be evaluated with debug scoring.' : undefined,
        anchorSelectionDebug: debug ? { routeId, osrmFailed: true } : undefined,
      };
    }

    if (debug) {
 console.log('[OSRMSourceRoute][AnchorSelectionDebug] osrm_route_geometry_result', {
        routeId,
        sourceCoordinates: { lat: startLat, lng: startLng },
        destinationCoordinates: { lat: endLat, lng: endLng },
        totalRouteDistanceKm: Number(routeGeometry?.distanceKm ?? 0),
      });
    }

 console.log('[OSRMSourceRoute] route_geometry_loaded', {
      routeId,
      sourceCityKey,
      destinationCityKey,
      points: routeGeometry.coordinates.length,
    });

    const candidate = hotspotMap.get(candidateHotspotId);
    const candidateLat = Number(candidate?.hotspot_latitude);
    const candidateLng = Number(candidate?.hotspot_longitude);
    const candidateDistanceFromRouteMeters = Number.isFinite(candidateLat) && Number.isFinite(candidateLng)
      ? this.distancePointToRouteMeters({ lat: candidateLat, lng: candidateLng }, routeGeometry.coordinates)
      : null;

 console.log('[OSRMSourceRoute] candidate_distance_checked', {
      routeId,
      candidateHotspotId,
      candidateDistanceFromRouteMeters,
    });

    const maxRouteMeters = Number(process.env.SOURCE_CITY_EXIT_MAX_ROUTE_METERS || 1000);
    const mapped = orderedExisting.map((item: any, index: number) => {
      const row = item.row;
      const lat = Number(row?.hotspot_latitude);
      const lng = Number(row?.hotspot_longitude);
      const locationKey = this.deriveLooseCityKey(String(row?.hotspot_location || ''));
      const distance = this.distancePointToRouteMeters({ lat, lng }, routeGeometry.coordinates);
      const progress = this.projectPointProgressOnRoute({ lat, lng }, routeGeometry.coordinates);
      return {
        index,
        hotspotId: Number(item.id),
        hotspotName: String(row?.hotspot_name || `Hotspot #${item.id}`),
        hotspotLocation: String(row?.hotspot_location || ''),
        locationKey,
        distanceFromRouteMeters: Number(distance),
        progressRatio: Number(progress),
      };
    });

    const candidateEvaluation = mapped.map((row: any) => {
      const isCandidateSelf = Number(row.hotspotId) === Number(candidateHotspotId);
      const isWithinDistance = Number(row.distanceFromRouteMeters) <= maxRouteMeters;
      const isSourceCity = !!sourceCityKey && String(row.locationKey || '') === String(sourceCityKey || '');
      const isBeforeDestinationProgress = Number(row.progressRatio) < 0.95;
      const accepted = !isCandidateSelf && isWithinDistance && (isSourceCity || isBeforeDestinationProgress);

      let reason = 'accepted';
      if (isCandidateSelf) {
        reason = 'rejected: current manual candidate hotspot is not eligible as source anchor';
      } else if (!isWithinDistance) {
        reason = `rejected: distanceFromRouteMeters exceeds threshold (${maxRouteMeters})`;
      } else if (!(isSourceCity || isBeforeDestinationProgress)) {
        reason = 'rejected: neither source city nor before destination-progress cutoff';
      }

      return {
        hotspot_ID: Number(row.hotspotId),
        hotspot_name: String(row.hotspotName || ''),
        distanceFromRouteMeters: Number(row.distanceFromRouteMeters),
        progressRatio: Number(row.progressRatio),
        isSourceCity,
        accepted,
        reason,
      };
    });

    if (debug) {
      for (const evalRow of candidateEvaluation) {
 console.log('[OSRMSourceRoute][AnchorSelectionDebug] candidate_evaluation', {
          routeId,
          hotspot_ID: Number(evalRow.hotspot_ID),
          hotspot_name: String(evalRow.hotspot_name),
          distanceFromRouteMeters: Number(evalRow.distanceFromRouteMeters),
          progressRatio: Number(evalRow.progressRatio),
          isSourceCity: evalRow.isSourceCity,
          decision: evalRow.accepted ? 'accepted' : 'rejected',
          reason: String(evalRow.reason),
        });
      }
    }

    const candidates = mapped
      .filter((row: any) => row.hotspotId !== candidateHotspotId)
      .filter((row: any) => row.distanceFromRouteMeters <= maxRouteMeters)
      .filter((row: any) => (
        (!!sourceCityKey && row.locationKey === sourceCityKey)
        || row.progressRatio < 0.95
      ))
      .sort((a: any, b: any) => b.progressRatio - a.progressRatio || a.distanceFromRouteMeters - b.distanceFromRouteMeters);

    const selected = candidates[0] || mapped[0] || null;
    if (!selected) {
      return null;
    }

    const selectedIndex = mapped.findIndex((row: any) => Number(row.hotspotId) === Number(selected.hotspotId));
    const nextRouteHotspotId = selectedIndex >= 0 && selectedIndex + 1 < mapped.length
      ? Number(mapped[selectedIndex + 1].hotspotId)
      : Number(mapped[1]?.hotspotId || 0);

    const selectionWhy = [
      `Selected hotspot ${Number(selected.hotspotId)} as source anchor because it is active on route ${routeId}.`,
      `distanceFromRouteMeters=${Number(selected.distanceFromRouteMeters).toFixed(2)} (threshold ${maxRouteMeters}).`,
      `sourceCityMatch=${String((!!sourceCityKey && String(selected.locationKey || '') === String(sourceCityKey || '')))}.`,
      'Among accepted source-side/on-route hotspots it had highest progressRatio before route exits source side.',
    ].join(' ');

    if (debug) {
 console.log('[OSRMSourceRoute][AnchorSelectionDebug] final_selected_anchor', {
        routeId,
        selectedHotspotId: Number(selected.hotspotId),
        selectedHotspotName: String(selected.hotspotName),
        whySelected: selectionWhy,
        nextRouteHotspotId,
      });
    }

 console.log('[OSRMSourceRoute] source_anchor_selected', {
      routeId,
      sourceAnchorHotspotId: Number(selected.hotspotId),
      sourceAnchorName: String(selected.hotspotName),
      sourceAnchorProgressRatio: Number(selected.progressRatio),
      sourceAnchorDistanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
      nextRouteHotspotId,
    });

    return {
      sourceAnchorHotspotId: Number(selected.hotspotId),
      sourceAnchorName: String(selected.hotspotName),
      sourceAnchorDistanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
      sourceAnchorProgressRatio: Number(selected.progressRatio),
      nextRouteHotspotId,
      osrmFailed: false,
      candidateDistanceFromRouteMeters,
      anchorSelectionWhy: debug ? selectionWhy : undefined,
      anchorSelectionDebug: debug
        ? {
            routeId,
            sourceCityKey,
            destinationCityKey,
            maxRouteMeters,
            candidateDistanceFromRouteMeters,
            candidateEvaluation,
            selected: {
              hotspot_ID: Number(selected.hotspotId),
              hotspot_name: String(selected.hotspotName),
              distanceFromRouteMeters: Number(selected.distanceFromRouteMeters),
              progressRatio: Number(selected.progressRatio),
            },
            nextRouteHotspotId,
          }
        : undefined,
    };
  }
}
