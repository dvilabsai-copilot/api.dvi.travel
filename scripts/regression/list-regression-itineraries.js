#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const { discoverRegressionPlans } = require('./cleanup-regression-itineraries');

async function main() {
  const prisma = new PrismaClient();
  try {
    const plans = await discoverRegressionPlans(prisma);
    if (!plans.length) {
      console.log('0 regression plans found');
      return;
    }

    const planIds = plans.map((plan) => Number(plan.planId)).filter((id) => Number.isFinite(id) && id > 0);
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: { in: planIds }, deleted: 0 },
      select: { itinerary_plan_ID: true },
    });
    const hotspots = await prisma.dvi_itinerary_route_hotspot_details.findMany({
      where: { itinerary_plan_ID: { in: planIds }, deleted: 0 },
      select: { itinerary_plan_ID: true },
    });

    const routeCounts = new Map();
    const hotspotCounts = new Map();
    for (const row of routes) {
      const key = Number(row.itinerary_plan_ID);
      routeCounts.set(key, (routeCounts.get(key) || 0) + 1);
    }
    for (const row of hotspots) {
      const key = Number(row.itinerary_plan_ID);
      hotspotCounts.set(key, (hotspotCounts.get(key) || 0) + 1);
    }

    for (const plan of plans) {
      const planId = Number(plan.planId);
      console.log(
        [
          `Plan ID: ${planId}`,
          `Quote ID: ${plan.quoteId}`,
          `Created Date: ${plan.createdon ? new Date(plan.createdon).toISOString() : '-'}`,
          `Status: ${plan.status}`,
          `Route Count: ${routeCounts.get(planId) || 0}`,
          `Hotspot Count: ${hotspotCounts.get(planId) || 0}`,
        ].join(' | '),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[REGRESSION_LIST] Failed:', err);
    process.exitCode = 1;
  });
}
