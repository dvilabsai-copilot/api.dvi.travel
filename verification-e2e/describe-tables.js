const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const a = await prisma.$queryRawUnsafe('DESCRIBE dvi_confirmed_itinerary_plan_details');
  const b = await prisma.$queryRawUnsafe('DESCRIBE hobse_hotel_booking_confirmation');
  console.log('TABLE_A');
  console.log(JSON.stringify(a,null,2));
  console.log('TABLE_B');
  console.log(JSON.stringify(b,null,2));
  await prisma.$disconnect();
})().catch(async e=>{ console.error(e); await prisma.$disconnect(); process.exit(1); });
