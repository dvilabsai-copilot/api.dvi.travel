import { HotspotEngineService } from '../src/modules/itineraries/engines/hotspot-engine.service';
import { PrismaService } from '../src/prisma.service';

async function main() {
  const quoteId = process.env.QUOTE_ID || 'DVI202604230';
  const prisma = new PrismaService();
  await prisma.onModuleInit();

  try {
    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: quoteId, deleted: 0 },
      select: { itinerary_plan_ID: true },
      orderBy: { itinerary_plan_ID: 'desc' },
    });

    if (!plan) {
      throw new Error(`Plan not found for quote ${quoteId}`);
    }

    const planId = Number(plan.itinerary_plan_ID);

    const firstRoute = await prisma.dvi_itinerary_route_details.findFirst({
      where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
      orderBy: [
        { no_of_days: 'asc' },
        { itinerary_route_date: 'asc' },
        { itinerary_route_ID: 'asc' },
      ],
      select: {
        itinerary_route_ID: true,
        itinerary_route_date: true,
        next_visiting_location: true,
        location_name: true,
      },
    });

    if (!firstRoute) {
      throw new Error(`No active routes found for plan ${planId}`);
    }

    const routeId = Number(firstRoute.itinerary_route_ID);
    const firstRouteDate = new Date(firstRoute.itinerary_route_date as any);
    const previousDayDate = new Date(
      Date.UTC(
        firstRouteDate.getUTCFullYear(),
        firstRouteDate.getUTCMonth(),
        firstRouteDate.getUTCDate() - 1,
        0,
        0,
        0,
      ),
    );

    const routeLocation = String(
      (firstRoute as any).next_visiting_location ||
        (firstRoute as any).location_name ||
        '',
    ).trim();

    const hotspotEngine = new HotspotEngineService(prisma);

    const result = await prisma.$transaction(
      async (tx) => {
        await (tx as any).dvi_itinerary_plan_hotel_details.deleteMany({
          where: {
            itinerary_plan_id: planId,
            itinerary_route_id: routeId,
            hotel_required: 2,
            hotel_id: 0,
            deleted: 0,
          },
        });

        await (tx as any).dvi_itinerary_plan_hotel_details.createMany({
          data: [1, 2, 3, 4].map((groupType) => ({
            group_type: groupType,
            itinerary_plan_id: planId,
            itinerary_route_id: routeId,
            itinerary_route_date: previousDayDate,
            itinerary_route_location: routeLocation || null,
            hotel_required: 2,
            hotel_id: 0,
            total_no_of_rooms: 0,
            total_hotel_cost: 0,
            total_hotel_tax_amount: 0,
            createdby: 1,
            createdon: new Date(),
            status: 1,
            deleted: 0,
          })),
        });

        const rebuild = await hotspotEngine.rebuildRouteHotspots(tx, planId);

        return {
          rebuildSummary: rebuild.rebuildSummary,
          warnings: rebuild.warnings,
        };
      },
      { timeout: 180000 },
    );

    const markers = await prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: {
        itinerary_plan_id: planId,
        itinerary_route_id: routeId,
        hotel_required: 2,
        hotel_id: 0,
        deleted: 0,
      },
      select: {
        group_type: true,
        itinerary_route_date: true,
        itinerary_route_location: true,
      },
      orderBy: { group_type: 'asc' },
    });

    console.log(
      JSON.stringify(
        {
          quoteId,
          planId,
          routeId,
          markerCount: markers.length,
          markers,
          rebuildSummary: result.rebuildSummary,
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
