require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
(async () => {
  const row1 = await prisma.$queryRawUnsafe("SELECT * FROM dvi_confirmed_itinerary_plan_details WHERE confirmed_itinerary_plan_ID = 129");
  const row2 = await prisma.$queryRawUnsafe("SELECT * FROM tbo_hotel_booking_confirmation WHERE tbo_booking_id = '2093541' OR tbo_booking_reference_number = '492149427502191'");
  console.log(JSON.stringify({ row1, row2 }, replacer, 2));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
