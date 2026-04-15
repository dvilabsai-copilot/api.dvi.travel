import { PrismaClient } from '@prisma/client';
import { HotspotEngineService } from '../src/modules/itineraries/engines/hotspot-engine.service';

const prisma = new PrismaClient();

async function run(): Promise<void> {
  const planId = 266;
  const routeId = 1872;

  const engine = new HotspotEngineService((prisma as unknown) as any);

  await prisma.$transaction(async (tx) => {
    await (tx as any).dvi_itinerary_route_details.update({
      where: { itinerary_route_ID: routeId },
      data: {
        route_start_time: new Date('1970-01-01T12:00:00.000Z'),
        route_end_time: new Date('1970-01-01T20:00:00.000Z'),
        updatedon: new Date(),
      },
    });

    const result = await engine.rebuildRouteHotspots((tx as unknown) as any, planId);
    console.log('REBUILD_OK', {
      summary: result.rebuildSummary,
      warnings: result.warnings?.length ?? 0,
    });
  }, { timeout: 120000 });
}

run()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('REBUILD_ERROR', error);
    await prisma.$disconnect();
    process.exit(1);
  });
