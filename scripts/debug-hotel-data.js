const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_quote_ID: 'DVI202604228', deleted: 0 },
      select: { itinerary_plan_ID: true }
    });
    
    if (!plan) {
      console.log('Plan not found');
      process.exit(0);
    }
    
    console.log('Plan ID:', plan.itinerary_plan_ID);
    
    const draftHotels = await prisma.dvi_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0 },
      take: 3
    });
    
    const confirmedHotels = await prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0 },
      take: 3
    });
    
    console.log('Draft hotel count:', await prisma.dvi_itinerary_plan_hotel_details.count({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0 }
    }));
    
    console.log('Confirmed hotel count:', await prisma.dvi_confirmed_itinerary_plan_hotel_details.count({
      where: { itinerary_plan_id: plan.itinerary_plan_ID, deleted: 0 }
    }));
    
    console.log('\nDraft hotel samples:', JSON.stringify(draftHotels, null, 2));
    console.log('\nConfirmed hotel samples:', JSON.stringify(confirmedHotels, null, 2));
    
    const routes = await prisma.dvi_itinerary_route_details.findMany({
      where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0 },
      select: { itinerary_route_ID: true, location_name: true, next_visiting_location: true },
      take: 3
    });
    
    console.log('\nFirst 3 routes:', JSON.stringify(routes, null, 2));
    
  } finally {
    await prisma.$disconnect();
  }
})();
