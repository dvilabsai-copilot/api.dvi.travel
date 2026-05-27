const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find plan ID for quote DVI20260589
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({
    where: { itinerary_quote_ID: 'DVI20260589', deleted: 0 },
    select: { itinerary_plan_ID: true }
  });
  
  if (!plan) {
    console.log('Plan not found for quote DVI20260589');
    await prisma.$disconnect();
    return;
  }
  
  console.log('Plan ID:', plan.itinerary_plan_ID);
  
  // Get all routes for this plan
  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0, status: 1 },
    select: { itinerary_route_ID: true, itinerary_route_date: true, location_name: true },
    orderBy: { itinerary_route_date: 'asc' }
  });
  
  console.log('\n=== ROUTES FOR PLAN ===');
  routes.forEach((r, i) => {
    console.log(`Day ${i + 1}: Route ID ${r.itinerary_route_ID}, Date: ${r.itinerary_route_date.toISOString().split('T')[0]}, Location: ${r.location_name}`);
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
