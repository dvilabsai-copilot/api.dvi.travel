export interface ItineraryDetailsVehicleKm {
  runningKm: number;
  sightseeingKm: number;
  totalKm: number;
}

/** Loads and aggregates persisted vehicle kilometres by itinerary route. */
export class ItineraryDetailsVehicleKmService {
  async load(prisma: any, planId: number): Promise<Map<number, ItineraryDetailsVehicleKm>> {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT itinerary_route_id, total_running_km, total_siteseeing_km, total_travelled_km
      FROM dvi_itinerary_plan_vendor_vehicle_details
      WHERE itinerary_plan_id = ${planId} AND deleted = 0
    `) as any[];
    const byRouteId = new Map<number, ItineraryDetailsVehicleKm>();
    for (const row of rows) {
      const routeId = Number(row?.itinerary_route_id || 0);
      if (!routeId) continue;
      const current = {
        runningKm: parseFloat(String(row?.total_running_km || 0)) || 0,
        sightseeingKm: parseFloat(String(row?.total_siteseeing_km || 0)) || 0,
        totalKm: parseFloat(String(row?.total_travelled_km || 0)) || 0,
      };
      const existing = byRouteId.get(routeId);
      byRouteId.set(routeId, existing ? {
        runningKm: Math.max(existing.runningKm, current.runningKm),
        sightseeingKm: Math.max(existing.sightseeingKm, current.sightseeingKm),
        totalKm: Math.max(existing.totalKm, current.totalKm),
      } : current);
    }
    return byRouteId;
  }
}
