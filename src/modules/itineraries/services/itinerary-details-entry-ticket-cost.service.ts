export type EntryTicketCostRow = {
  traveller_type: number;
  entry_ticket_cost: number;
};

/** Loads and groups persisted entry-ticket costs for itinerary details. */
export class ItineraryDetailsEntryTicketCostService {
  async load(prisma: any, planId: number): Promise<Map<number, EntryTicketCostRow[]>> {
    const rows = await prisma.dvi_itinerary_route_hotspot_entry_cost_details.findMany({
      where: { itinerary_plan_id: planId, deleted: 0, status: 1 },
      select: {
        route_hotspot_id: true,
        traveller_type: true,
        entry_ticket_cost: true,
      },
      orderBy: { hotspot_cost_detail_id: 'asc' },
    });
    const grouped = new Map<number, EntryTicketCostRow[]>();
    for (const row of rows) {
      const routeHotspotId = Number(row.route_hotspot_id || 0);
      if (!routeHotspotId) continue;
      const costs = grouped.get(routeHotspotId) || [];
      costs.push({
        traveller_type: Number(row.traveller_type || 0),
        entry_ticket_cost: Number(row.entry_ticket_cost || 0),
      });
      grouped.set(routeHotspotId, costs);
    }
    return grouped;
  }
}
