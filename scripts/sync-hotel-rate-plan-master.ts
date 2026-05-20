import { PrismaClient } from '@prisma/client';
import { CANONICAL_HOTEL_RATE_PLANS } from '../src/modules/hotels/hotel-rate-plans';

const prisma = new PrismaClient();

async function main() {
  const synced: Array<{ code: string; rateplanId: string }> = [];

  for (const plan of CANONICAL_HOTEL_RATE_PLANS) {
    await prisma.dvi_hotel_rate_plan_master.upsert({
      where: { rate_plan_code: plan.code },
      update: {
        default_rateplan_id: plan.defaultRateplanId,
        rate_plan_name: plan.name,
        description: plan.description,
        includes_breakfast: plan.includesBreakfast,
        includes_lunch: plan.includesLunch,
        includes_dinner: plan.includesDinner,
        sort_order: plan.sortOrder,
        status: 1,
        deleted: 0,
        updatedon: new Date(),
      },
      create: {
        rate_plan_code: plan.code,
        default_rateplan_id: plan.defaultRateplanId,
        rate_plan_name: plan.name,
        description: plan.description,
        includes_breakfast: plan.includesBreakfast,
        includes_lunch: plan.includesLunch,
        includes_dinner: plan.includesDinner,
        sort_order: plan.sortOrder,
        status: 1,
        deleted: 0,
        createdon: new Date(),
        updatedon: new Date(),
      },
    });

    synced.push({
      code: plan.code,
      rateplanId: plan.defaultRateplanId,
    });
  }

  console.log(JSON.stringify({ status: 'ok', synced }, null, 2));
}

main()
  .catch((error) => {
    console.error('Failed to sync hotel rate plan master:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });