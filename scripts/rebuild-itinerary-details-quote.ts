import { HotspotEngineService } from '../src/modules/itineraries/engines/hotspot-engine.service';
import { PrismaService } from '../src/prisma.service';

async function main() {
  const quoteId = process.env.QUOTE_ID || 'DVI202604228';
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

    const hotspotEngine = new HotspotEngineService(prisma);
    const result = await prisma.$transaction(
      async (tx) => hotspotEngine.rebuildRouteHotspots(tx, Number(plan.itinerary_plan_ID)),
      { timeout: 180000 },
    );

    console.log(
      JSON.stringify(
        {
          quoteId,
          planId: Number(plan.itinerary_plan_ID),
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
