const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const safe = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2);
(async () => {
  const hotelId = 153;
  const propertyId = 'AX_DVI_HOTEL_153';
  const rooms = await prisma.dvi_hotel_rooms.findMany({
    where: { hotel_id: hotelId, deleted: 0, status: 1 },
    select: { room_ID: true, room_title: true, room_ref_code: true, room_type_id: true, breakfast_included: true, lunch_included: true, dinner_included: true },
    orderBy: { room_ID: 'asc' },
  });
  const rateplansByCode = await prisma.axisrooms_rateplan.groupBy({
    by: ['rateplan_id'],
    where: { axisrooms_property_id: propertyId },
    _count: { rateplan_id: true },
  });
  const canonicalCodes = ['CP', 'EP', 'MAP', 'AP', 'CP_PLAN', 'EP_PLAN', 'MAP_PLAN', 'AP_PLAN'];
  const canonicalRows = await prisma.axisrooms_rateplan.findMany({
    where: { axisrooms_property_id: propertyId, rateplan_id: { in: canonicalCodes } },
    select: { room_id: true, rateplan_id: true, rateplan_name: true, occupancy: true, created_at: true },
    orderBy: [{ rateplan_id: 'asc' }, { room_id: 'asc' }],
  });
  const sampleRates = await prisma.axisrooms_rate.findMany({
    where: { axisrooms_property_id: propertyId },
    select: { room_id: true, rateplan_id: true, start_date: true, end_date: true, occupancy_rates: true },
    orderBy: [{ rateplan_id: 'asc' }, { start_date: 'desc' }],
    take: 20,
  });
  const pricebookSummary = await prisma.dvi_hotel_room_price_book.groupBy({
    by: ['room_id', 'room_type_id', 'price_type', 'year', 'month'],
    where: { hotel_id: hotelId, deleted: 0, status: 1 },
    _count: { hotel_price_book_id: true },
    _max: { hotel_price_book_id: true },
    orderBy: [{ room_id: 'asc' }, { price_type: 'asc' }, { year: 'desc' }, { month: 'asc' }],
    take: 40,
  });
  console.log(safe({ rooms, rateplansByCode, canonicalRows, sampleRates, pricebookSummary }));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
