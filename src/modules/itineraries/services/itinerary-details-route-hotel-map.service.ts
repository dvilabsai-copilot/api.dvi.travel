type RouteHotelMapParams = {
  prisma: any;
  planId: number;
  confirmedPlan: unknown;
  groupType?: number;
  routes: any[];
  isVehicleOnly: boolean;
};

/** Hydrates the route-to-hotel display map used by itinerary details. */
export class ItineraryDetailsRouteHotelMapService {
  async build(params: RouteHotelMapParams): Promise<Map<number, any>> {
    const { prisma, planId, confirmedPlan, groupType, routes, isVehicleOnly } = params;
    let timelineHotelRows: any[] = [];

    if (confirmedPlan) {
      timelineHotelRows = await prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
        where: { itinerary_plan_id: planId, deleted: 0 },
        select: {
          hotel_id: true,
          hotel_code: true,
          itinerary_route_id: true,
          group_type: true,
        },
      });
      console.log(`[Timeline Hotels] Fetched ${timelineHotelRows.length} hotels from CONFIRMED table`);
    } else {
      const timelineHotelWhere: any = { itinerary_plan_id: planId, deleted: 0 };
      timelineHotelWhere.group_type = groupType !== undefined ? groupType : 1;

      timelineHotelRows = await prisma.dvi_itinerary_plan_hotel_details.findMany({
        where: timelineHotelWhere,
        select: {
          hotel_id: true,
          hotel_code: true,
          itinerary_route_id: true,
          group_type: true,
        },
      });
      console.log(
        `[Timeline Hotels] Fetched ${timelineHotelRows.length} hotels from DRAFT table with group_type=${timelineHotelWhere.group_type}`,
      );
    }

    const routeHotelRowMap = new Map(timelineHotelRows.map((h) => [h.itinerary_route_id, h]));
    const hotelIds = Array.from(
      new Set(
        timelineHotelRows
          .map((h) => Number(h.hotel_id ?? 0))
          .filter((id) => id > 0),
      ),
    );
    const hotelMasters = hotelIds.length > 0
      ? await prisma.dvi_hotel.findMany({
          where: { hotel_id: { in: hotelIds } },
          select: { hotel_id: true, hotel_name: true, hotel_address: true },
        })
      : [];
    const hotelMasterMap = new Map<number, any>(hotelMasters.map((h: any) => [h.hotel_id, h]));

    const tboConfirmationRows = await prisma.tbo_hotel_booking_confirmation.findMany({
      where: { itinerary_plan_ID: planId, status: 1, deleted: 0 },
      select: { itinerary_route_ID: true, tbo_hotel_code: true },
      distinct: ['itinerary_route_ID'],
    });
    const tboConfirmationMap = new Map(
      tboConfirmationRows.map((r: any) => [Number(r.itinerary_route_ID), r.tbo_hotel_code]),
    );
    const tboHotelCodes = Array.from(
      new Set(
        [
          ...timelineHotelRows.map((h: any) => String(h?.hotel_code ?? '').trim()),
          ...tboConfirmationRows.map((r: any) => String(r?.tbo_hotel_code ?? '').trim()),
        ].filter((code) => code.length > 0),
      ),
    );
    const tboHotelMasters = tboHotelCodes.length
      ? await prisma.tbo_hotel_master.findMany({
          where: { tbo_hotel_code: { in: tboHotelCodes } },
          select: { tbo_hotel_code: true, hotel_name: true, hotel_address: true },
        })
      : [];
    const tboHotelMasterMap = new Map<string, any>(tboHotelMasters.map((h: any) => [h.tbo_hotel_code, h]));

    const liveRouteHotelFallbackMap = new Map<
      number,
      { hotel_name: string; hotel_address: string | null; hotel_code: string | null; price: number }
    >();
    const routeHotelMap = new Map<number, any>();

    for (const [routeId, hotelRow] of routeHotelRowMap.entries()) {
      const hotelIdNum = Number((hotelRow as any)?.hotel_id ?? 0);
      const masterInfo = hotelMasterMap.get(hotelIdNum);
      let hotelCode = String((hotelRow as any)?.hotel_code ?? '').trim();
      if (!hotelCode && tboConfirmationMap.has(routeId)) {
        hotelCode = String(tboConfirmationMap.get(routeId) ?? '').trim();
      }
      const liveFallback = liveRouteHotelFallbackMap.get(Number(routeId));
      if (!hotelCode && liveFallback?.hotel_code) {
        hotelCode = String(liveFallback.hotel_code).trim();
      }
      const tboInfo = hotelCode.length ? tboHotelMasterMap.get(hotelCode) : null;
      routeHotelMap.set(routeId, {
        hotel_id: hotelIdNum,
        hotel_name: liveFallback?.hotel_name ?? masterInfo?.hotel_name ?? tboInfo?.hotel_name ?? null,
        hotel_address: liveFallback?.hotel_address ?? masterInfo?.hotel_address ?? tboInfo?.hotel_address ?? null,
        hotel_code: hotelCode,
      });
    }

    for (const route of routes) {
      const routeIdNum = Number((route as any)?.itinerary_route_ID ?? 0);
      if (!routeIdNum || routeHotelMap.has(routeIdNum)) continue;
      const liveFallback = liveRouteHotelFallbackMap.get(routeIdNum);
      if (!liveFallback) continue;
      routeHotelMap.set(routeIdNum, {
        hotel_id: 0,
        hotel_name: liveFallback.hotel_name,
        hotel_address: liveFallback.hotel_address,
        hotel_code: liveFallback.hotel_code ?? '',
      });
    }

    if (isVehicleOnly) {
      for (const route of routes) {
        const routeIdNum = Number((route as any)?.itinerary_route_ID ?? 0);
        if (!routeIdNum) continue;
        const existing = routeHotelMap.get(routeIdNum) || {};
        routeHotelMap.set(routeIdNum, { ...existing, hotel_name: 'Hotel', hotel_address: null });
      }
    }

    return routeHotelMap;
  }
}
