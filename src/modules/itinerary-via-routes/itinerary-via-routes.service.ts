// FILE: src/modules/itinerary-via-routes/itinerary-via-routes.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { CheckDistanceLimitDto } from './dto/check-distance-limit.dto';
import { AddViaRouteDto } from './dto/add-via-route.dto';

type DistanceCheckResponse =
  | { success: true }
  | { success: false; errors: { result_error: string } };

type AddViaRouteResponse =
  | { success: true; i_result?: boolean; u_result?: boolean }
  | { success: false; errors: Record<string, any> };

@Injectable()
export class ItineraryViaRoutesService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toRad(value: number): number {
    return (value * Math.PI) / 180;
  }

  /**
   * Haversine distance between two lat/long pairs in KM.
   */
  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(lat2 - lat1);
    // FIX: use lon2 - lon1 (bug was lat2 - lon1)
    const dLon = this.toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Fetch a stored location's coordinates by its name.
   * Matches either source_location or destination_location in dvi_stored_locations
   * and returns the appropriate lat/long.
   */
  private normalizeLocationName(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,\s*india$/i, '');
}

private toCoords(latValue: any, lonValue: any) {
  if (latValue == null || lonValue == null) return null;

  const lat = Number(latValue);
  const lon = Number(lonValue);

  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;

  return { lat, lon };
}

private async getLocationCoordsByName(locationName: string) {
  const rawName = String(locationName || '').trim();
  if (!rawName) return null;

  const shortName = rawName.split(',')[0]?.trim() || rawName;
  const normalizedInput = this.normalizeLocationName(rawName);
  const normalizedShort = this.normalizeLocationName(shortName);

  const rows = await this.prisma.dvi_stored_locations.findMany({
    where: {
      deleted: 0,
      status: 1,
      OR: [
        { source_location: rawName },
        { destination_location: rawName },
        { source_location: shortName },
        { destination_location: shortName },
        { source_location: { contains: rawName } },
        { destination_location: { contains: rawName } },
        { source_location: { contains: shortName } },
        { destination_location: { contains: shortName } },
      ],
    },
    select: {
      source_location: true,
      source_location_lattitude: true,
      source_location_longitude: true,
      destination_location: true,
      destination_location_lattitude: true,
      destination_location_longitude: true,
    },
    take: 50,
  });

  for (const row of rows) {
    const sourceName = this.normalizeLocationName(row.source_location);
    const destinationName = this.normalizeLocationName(row.destination_location);

    const sourceMatches =
      sourceName === normalizedInput ||
      sourceName === normalizedShort ||
      normalizedInput.includes(sourceName) ||
      sourceName.includes(normalizedShort);

    if (sourceMatches) {
      const coords = this.toCoords(
        row.source_location_lattitude,
        row.source_location_longitude,
      );

      if (coords) return coords;
    }

    const destinationMatches =
      destinationName === normalizedInput ||
      destinationName === normalizedShort ||
      normalizedInput.includes(destinationName) ||
      destinationName.includes(normalizedShort);

    if (destinationMatches) {
      const coords = this.toCoords(
        row.destination_location_lattitude,
        row.destination_location_longitude,
      );

      if (coords) return coords;
    }
  }

  console.warn('[ViaRoutes] Unable to resolve coordinates for location:', rawName);

  return null;
}
  /**
   * Given via route IDs from dvi_stored_location_via_routes, resolve them to
   * location names and then fetch their coordinates from dvi_stored_locations.
   */
  private async getViaLocationsCoordsByIds(viaRouteIds: (number | string)[]) {
    if (!viaRouteIds?.length) return [];

    const idsBigInt = viaRouteIds
      .map((v) => {
        try {
          return BigInt(v);
        } catch {
          return null;
        }
      })
      .filter((v): v is bigint => v !== null);

    if (!idsBigInt.length) return [];

    const viaRows =
      await this.prisma.dvi_stored_location_via_routes.findMany({
        where: {
          deleted: 0,
          status: 1,
          via_route_location_ID: { in: idsBigInt },
        },
        select: {
          via_route_location: true,
        },
        orderBy: {
          via_route_location_ID: 'asc',
        },
      });

    const result: { name: string; lat: number; lon: number }[] = [];

    for (const via of viaRows) {
      if (!via.via_route_location) continue;
      const coords = await this.getLocationCoordsByName(
        via.via_route_location,
      );
      if (coords) {
        result.push({
          name: via.via_route_location,
          lat: coords.lat,
          lon: coords.lon,
        });
      }
    }

    return result;
  }

  private async getItineraryDistanceLimit(): Promise<number | null> {
    const row = await this.prisma.dvi_global_settings.findFirst({
      where: {
        deleted: 0,
        status: 1,
      },
      select: {
        itinerary_distance_limit: true,
      },
    });

    if (!row || row.itinerary_distance_limit == null) return null;
    return Number(row.itinerary_distance_limit);
  }

  // -------------------------------------------------------------------------
  // 1) check_distance_limit
  // -------------------------------------------------------------------------

  async checkDistanceLimit(
    dto: CheckDistanceLimitDto,
  ): Promise<DistanceCheckResponse> {
    const { source, destination, via_routes } = dto;

    // Resolve source/destination coordinates
    const sourceCoords = await this.getLocationCoordsByName(source);
    const destCoords = await this.getLocationCoordsByName(destination);

    if (!sourceCoords || !destCoords) {
      return {
        success: false,
        errors: {
          result_error: 'Unable to resolve source / destination coordinates',
        },
      };
    }

    // Resolve via-route coordinates in order
    const viaCoords = await this.getViaLocationsCoordsByIds(via_routes);

    let cumulative = 0;

    // 1) Source -> first via
    if (viaCoords.length > 0) {
      const first = viaCoords[0];
      cumulative += this.haversineDistance(
        sourceCoords.lat,
        sourceCoords.lon,
        first.lat,
        first.lon,
      );
    }

    // 2) Via[i] -> Via[i+1]
    for (let i = 0; i < viaCoords.length - 1; i++) {
      const curr = viaCoords[i];
      const next = viaCoords[i + 1];
      cumulative += this.haversineDistance(
        curr.lat,
        curr.lon,
        next.lat,
        next.lon,
      );
    }

    // 3) Last via -> destination
    if (viaCoords.length > 0) {
      const last = viaCoords[viaCoords.length - 1];
      cumulative += this.haversineDistance(
        last.lat,
        last.lon,
        destCoords.lat,
        destCoords.lon,
      );
    }

    // Round to match PHP behaviour
    cumulative = Math.round(cumulative);

    const limit = await this.getItineraryDistanceLimit();
    if (limit == null) {
      // If no limit is configured, consider it a success.
      return { success: true };
    }

    if (cumulative < 0) {
      return {
        success: false,
        errors: { result_error: 'Unable to Add Via Route !!!' },
      };
    }

    if (cumulative > limit) {
      return {
        success: false,
        errors: { result_error: 'Distance KM Limit Exceeded !!!' },
      };
    }

    return { success: true };
  }

  // -------------------------------------------------------------------------
  // 2) add_via_route
  // -------------------------------------------------------------------------

  private parseRouteDate(input: string): Date | null {
    // expects dd/mm/yyyy
    if (!input) return null;
    const parts = input.split('/');
    if (parts.length !== 3) return null;
    const [dStr, mStr, yStr] = parts;
    const d = Number(dStr);
    const m = Number(mStr);
    const y = Number(yStr);
    if (!d || !m || !y) return null;
    return new Date(y, m - 1, d);
  }

// REPLACE the whole addViaRoute method in itinerary-via-routes.service.ts
async addViaRoute(dto: AddViaRouteDto): Promise<AddViaRouteResponse> {
  const routeDate = this.parseRouteDate(dto.hidden_route_date);

  // These are Int in Prisma model, so use number (NOT BigInt)
  const itineraryRouteId =
    dto.itinerary_route_ID != null && dto.itinerary_route_ID !== ''
      ? Number(dto.itinerary_route_ID)
      : null;
  const itineraryPlanId =
    dto.itinerary_plan_ID != null && dto.itinerary_plan_ID !== ''
      ? Number(dto.itinerary_plan_ID)
      : null;

  // 1) Build a "segment" filter for this leg (plan+route OR session+source+dest)
  const segmentWhere: any = {
    deleted: 0,
    status: 1,
  };

  if (itineraryPlanId != null) {
    segmentWhere.itinerary_plan_ID = itineraryPlanId;
  }
  if (itineraryRouteId != null) {
    segmentWhere.itinerary_route_ID = itineraryRouteId;
  }

  // New / unsaved itinerary – we only have session + locations
  if (itineraryPlanId == null && itineraryRouteId == null) {
    if (dto.itinerary_session_id) {
      segmentWhere.itinerary_session_id = dto.itinerary_session_id;
    }
    if (dto.hidden_source_location) {
      segmentWhere.source_location = dto.hidden_source_location;
    }
    if (dto.hidden_destination_location) {
      segmentWhere.destination_location = dto.hidden_destination_location;
    }
  }

  const hasSegmentKey =
    Object.keys(segmentWhere).filter(
      (k) => k !== 'deleted' && k !== 'status',
    ).length > 0;

  // 2) Soft-delete ALL existing via routes for this leg
  //    This makes the API behave like "replace the set" (same as PHP UI).
  if (hasSegmentKey) {
    await this.prisma.dvi_itinerary_via_route_details.updateMany({
      where: segmentWhere,
      data: { deleted: 1 },
    });
  }

  // 3) If user cleared all via routes, we're done after delete.
  if (!dto.via_route_location || dto.via_route_location.length === 0) {
    return {
      success: true,
    };
  }

  let anyInsert = false;

  // 4) Insert the current selection as fresh rows
  for (let index = 0; index < dto.via_route_location.length; index++) {
    const viaLocationIdRaw = dto.via_route_location[index];

    // For dvi_itinerary_via_route_details (Int)
    const viaLocationId = Number(viaLocationIdRaw);

    // For dvi_stored_location_via_routes (BigInt)
    const viaLocationIdBigInt = BigInt(viaLocationIdRaw);

    // Look up human-readable location name from via-routes table
    const viaRow =
      await this.prisma.dvi_stored_location_via_routes.findUnique({
        where: {
          // this model's PK is BigInt, so we use the BigInt version
          via_route_location_ID: viaLocationIdBigInt,
        },
        select: {
          via_route_location: true,
        },
      });

    const viaLocationName = viaRow?.via_route_location ?? '';

    const baseData: any = {
      itinerary_route_date: routeDate,
      source_location: dto.hidden_source_location,
      destination_location: dto.hidden_destination_location,
      // Int field – use number
      itinerary_via_location_ID: viaLocationId,
      itinerary_via_location_name: viaLocationName,
      itinerary_session_id: dto.itinerary_session_id ?? null,
      createdby:
        dto.createdby != null && dto.createdby !== ''
          ? Number(dto.createdby) // Int in model
          : null,
      status: 1,
      deleted: 0,
    };

    if (itineraryRouteId != null) {
      baseData.itinerary_route_ID = itineraryRouteId;
    }
    if (itineraryPlanId != null) {
      baseData.itinerary_plan_ID = itineraryPlanId;
    }

    await this.prisma.dvi_itinerary_via_route_details.create({
      data: baseData,
    });
    anyInsert = true;
  }

  return {
    success: true,
    i_result: anyInsert || undefined,
  };
}

  // -------------------------------------------------------------------------
  // 3) FORM DATA (equivalent of ajax_latest_itineary_via_route_form.php?type=show_form)
  // -------------------------------------------------------------------------

  /**
   * Returns the data required for the React ViaRouteDialog:
   *  - dropdown options (via routes **for this source/destination pair**)
   *  - existing via routes for this segment (if any)
   *
   * This mimics PHP getSTOREDLOCATION_VIAROUTE_DROPDOWN by:
   *   1) finding `location_ID` in dvi_stored_locations
   *   2) filtering dvi_stored_location_via_routes by that `location_id`
   */
// -------------------------------------------------------------------------
// 3) FORM DATA (equivalent of ajax_latest_itineary_via_route_form.php?type=show_form)
// -------------------------------------------------------------------------
async getForm(query: any) {
  const source = (query.source || query.selected_source_location || '').trim();
  const destination = (
    query.destination ||
    query.selected_next_visiting_location ||
    ''
  ).trim();

  // "0" should behave as "no id" (same as PHP)
  const itinerary_plan_ID =
    query.itinerary_plan_ID && query.itinerary_plan_ID !== '0'
      ? Number(query.itinerary_plan_ID)
      : null;

  const itinerary_route_ID =
    query.itinerary_route_ID && query.itinerary_route_ID !== '0'
      ? Number(query.itinerary_route_ID)
      : null;

  // React-side session id (react_xxx), same as PHP session_id()
  const itinerary_session_id =
    typeof query.itinerary_session_id === 'string' &&
    query.itinerary_session_id.trim() !== ''
      ? query.itinerary_session_id.trim()
      : null;

  // DD/MM/YYYY coming from React (or PHP-style param)
  const routeDateStr = (
    query.itinerary_route_date ||
    query.date ||
    ''
  ).toString().trim();
  const routeDate = routeDateStr ? this.parseRouteDate(routeDateStr) : null;

  console.log('VIA ROUTE FORM REQUEST:', {
    source,
    destination,
    itinerary_plan_ID,
    itinerary_route_ID,
    itinerary_session_id,
    routeDateStr,
  });

  // -------- 3.1 Find base location row in dvi_stored_locations ----------
  // CRITICAL: This must match EXACTLY how PHP does it
  let locationId: bigint | null = null;

  if (source && destination) {
    const baseLocation = await this.prisma.dvi_stored_locations.findFirst({
      where: {
        deleted: 0,
        status: 1,
        source_location: source,
        destination_location: destination,
      },
      select: {
        location_ID: true,
      },
    });

    console.log('FOUND BASE LOCATION:', baseLocation);

    if (baseLocation && baseLocation.location_ID != null) {
      locationId = baseLocation.location_ID;
    } else {
      console.log('NO LOCATION FOUND FOR:', { source, destination });
    }
  }

  // -------- 3.2 Existing via-route rows for this itinerary -------------
  let viaRowsForSegment:
    | {
        itinerary_via_route_ID: number;
        itinerary_via_location_ID: number | null;
        itinerary_via_location_name: string | null;
      }[] = [];

  if (itinerary_plan_ID && itinerary_route_ID) {
    // EDIT mode – saved itinerary (same as PHP plan+route filter)
    viaRowsForSegment =
      await this.prisma.dvi_itinerary_via_route_details.findMany({
        where: {
          deleted: 0,
          status: 1,
          itinerary_plan_ID,
          itinerary_route_ID,
        },
        orderBy: { itinerary_via_route_ID: 'asc' },
        select: {
          itinerary_via_route_ID: true,
          itinerary_via_location_ID: true,
          itinerary_via_location_name: true,
        },
      });
  } else if (itinerary_session_id) {
    // NEW itinerary – React session (PHP: date + session).
    // To avoid DATE vs DateTime issues we rely on session + source + destination.
    const where: any = {
      deleted: 0,
      status: 1,
      itinerary_session_id,
    };

    if (source) {
      where.source_location = source;
    }
    if (destination) {
      where.destination_location = destination;
    }

    // routeDate is NOT used in the filter – that is the key change.
    // It avoids mismatches caused by timezone / DateTime vs DATE.
    console.log('WHERE for via routes fetch (session mode):', where);

    viaRowsForSegment =
      await this.prisma.dvi_itinerary_via_route_details.findMany({
        where,
        orderBy: { itinerary_via_route_ID: 'asc' },
        select: {
          itinerary_via_route_ID: true,
          itinerary_via_location_ID: true,
          itinerary_via_location_name: true,
        },
      });
  }

  const existing = viaRowsForSegment.map((row) => ({
    id: row.itinerary_via_route_ID,
    viaLocationId: row.itinerary_via_location_ID ?? 0,
    viaLocationName: row.itinerary_via_location_name ?? '',
  }));

  // -------- 3.3 Options for dropdown: dvi_stored_location_via_routes ----
      // -------- 3.3 Options for dropdown: via routes + matched route details ----
  let optionsRows: {
    via_route_location_ID: bigint;
    via_route_location: string | null;
  }[] = [];

  if (locationId != null) {
    console.log('FETCHING VIA ROUTES FOR location_id:', locationId);

    const baseViaRows =
      await this.prisma.dvi_stored_location_via_routes.findMany({
        where: {
          deleted: 0,
          status: 1,
          location_id: locationId,
        },
        orderBy: {
          via_route_location: 'asc',
        },
        select: {
          via_route_location_ID: true,
          via_route_location: true,
        },
      });

    console.log('BASE VIA ROUTE OPTIONS FOUND:', baseViaRows.length);

    const suggestedDetailRows = await this.prisma.$queryRawUnsafe<
      Array<{ route_location_name: string | null }>
    >(
      `
      SELECT
        d.route_location_name
      FROM dvi_stored_routes r
      INNER JOIN dvi_stored_route_location_details d
        ON d.stored_route_id = r.stored_route_ID
       AND d.deleted = 0
      WHERE r.deleted = 0
        AND r.location_id = ?
      ORDER BY d.stored_route_location_ID ASC
      `,
      Number(locationId),
    );

    console.log(
      'SUGGESTED ROUTE DETAIL ROWS FOUND:',
      suggestedDetailRows.length,
    );

    const baseViaMap = new Map<string, (typeof baseViaRows)[number]>();

    for (const row of baseViaRows) {
      const viaName = String(row.via_route_location ?? '').trim().toLowerCase();
      if (!viaName) continue;
      if (!baseViaMap.has(viaName)) {
        baseViaMap.set(viaName, row);
      }
    }

    const mergedRows: typeof baseViaRows = [...baseViaRows];
    const seenViaIds = new Set(
      baseViaRows.map((row) => row.via_route_location_ID.toString()),
    );

    for (const detailRow of suggestedDetailRows) {
      const detailName = String(detailRow.route_location_name ?? '')
        .trim()
        .toLowerCase();

      if (!detailName) continue;

      const matchedViaRow = baseViaMap.get(detailName);
      if (!matchedViaRow) continue;

      const viaId = matchedViaRow.via_route_location_ID.toString();
      if (seenViaIds.has(viaId)) continue;

      seenViaIds.add(viaId);
      mergedRows.push(matchedViaRow);
    }

    optionsRows = mergedRows;

    console.log('FINAL VIA ROUTE OPTIONS AFTER MERGE:', optionsRows.length);
  } else {
    console.log('CANNOT FETCH VIA ROUTES - locationId is null');
  }

  const options = optionsRows
    .filter((r) => !!r.via_route_location)
    .map((r) => ({
      id: r.via_route_location_ID.toString(),
      label: r.via_route_location as string,
    }));

  console.log('FINAL RESPONSE:', {
    existingCount: existing.length,
    optionsCount: options.length,
  });

  return {
    success: true,
    data: {
      existing,
      options,
    },
  };
}

}
