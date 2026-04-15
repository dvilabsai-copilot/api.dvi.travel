const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  try {
    const hotel = await p.dvi_hotel.findFirst({
      where: { 
        hotel_name: { contains: 'Prem Nivas' },
        deleted: false
      },
      select: { hotel_id: true, hotel_name: true, hotel_city: true }
    });
    
    console.log('Hotel Prem Nivas lookup:', JSON.stringify(hotel, null, 2));
    
    // Also check what's the city for Madurai day 1
    const mts = await p.dvi_hotel.findMany({
      where: { hotel_city: { contains: 'Madurai' } },
      select: { hotel_id: true, hotel_name: true, hotel_city: true },
      take: 5
    });
    
    console.log('\nHotels in Madurai:', JSON.stringify(mts, null, 2));
  } finally {
    await p.$disconnect();
  }
})();
