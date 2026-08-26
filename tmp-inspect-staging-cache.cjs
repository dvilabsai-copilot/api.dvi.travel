require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const rows = await prisma.dvi_itinerary_hotel_search_cache.findMany({
    where: { quote_id: 'DVI20260891', deleted: 0, status: 1 },
    orderBy: [{ route_id: 'asc' }, { group_type: 'asc' }, { sort_rank: 'asc' }],
  });
  const result = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(row.full_payload); } catch {}
    return {
      routeId: row.route_id,
      group: row.group_type,
      hotel: row.hotel_name,
      provider: row.provider,
      hotelCode: row.hotel_code,
      price: row.price,
      checkIn: String(row.check_in_date).slice(0, 10),
      checkOut: String(row.check_out_date).slice(0, 10),
      routeIds: payload.routeIds,
      completeStayBookable: payload.completeStayBookable,
      availabilityStatus: payload.availabilityStatus,
      isSelectable: payload.isSelectable,
      selectionOrigin: payload.selectionOrigin,
      selected: payload.isSelected,
      roomType: payload.roomType,
      mealPlan: payload.mealPlan,
    };
  });
  process.stdout.write(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
