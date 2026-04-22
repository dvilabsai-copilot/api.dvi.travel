const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const canonical = ['CP', 'EP', 'MAP', 'AP', 'CP_PLAN', 'EP_PLAN', 'MAP_PLAN', 'AP_PLAN'];
  const plans = await prisma.axisrooms_rateplan.findMany({
    where: { rateplan_id: { in: canonical } },
    select: { axisrooms_property_id: true, room_id: true, rateplan_id: true, rateplan_name: true, occupancy: true },
    orderBy: [{ axisrooms_property_id: 'asc' }, { room_id: 'asc' }, { rateplan_id: 'asc' }],
  });
  const rates = await prisma.axisrooms_rate.findMany({
    where: { rateplan_id: { in: canonical } },
    select: { axisrooms_property_id: true, room_id: true, rateplan_id: true, start_date: true, end_date: true, occupancy_rates: true },
    orderBy: [{ axisrooms_property_id: 'asc' }, { room_id: 'asc' }, { rateplan_id: 'asc' }, { start_date: 'asc' }],
    take: 50,
  });
  console.log(JSON.stringify({ plans, rates }, (_, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
