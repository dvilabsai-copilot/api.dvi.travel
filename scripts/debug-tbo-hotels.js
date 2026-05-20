const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  try {
    const confirmations = await p.tbo_hotel_booking_confirmation.findMany({
      where: { itinerary_plan_ID: 266, deleted: 0 },
      select: { itinerary_route_ID: true, tbo_hotel_code: true, tbo_booking_reference_number: true },
      take: 5
    });
    
    console.log('TBO confirmations count:', confirmations.length);
    console.log('Sample TBO confirmations:', JSON.stringify(confirmations, null, 2));
    
    if (confirmations.length > 0) {
      const codes = [...new Set(confirmations.map(c => c.tbo_hotel_code))];
      const tboHotels = await p.tbo_hotel_master.findMany({
        where: { tbo_hotel_code: { in: codes } },
        select: { tbo_hotel_code: true, hotel_name: true }
      });
      console.log('\nTBO hotel masters:', JSON.stringify(tboHotels, null, 2));
    }
  } finally {
    await p.$disconnect();
  }
})();
