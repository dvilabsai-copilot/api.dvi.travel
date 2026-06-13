import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { RouteEngineService } from '../src/modules/itineraries/engines/route-engine.service';

async function main() {
  const planId = Number(process.argv[2] ?? 0);
  const userId = Number(process.argv[3] ?? 1);

  if (!planId) {
    throw new Error('Usage: tsx scripts/rebuild-permit-charges.ts <planId> [userId]');
  }

  const prisma = new PrismaClient();
  const routeEngine = new RouteEngineService();

  try {
    await prisma.$transaction(async (tx) => {
      await routeEngine.rebuildPermitCharges(tx as any, planId, userId);
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          planId,
          userId,
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
