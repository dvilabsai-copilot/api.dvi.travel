const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function dump(quoteId) {
  const plan = await prisma.dvi_itinerary_plan_details.findFirst({ where: { itinerary_quote_ID: quoteId, deleted: 0 }, select: { itinerary_plan_ID: true } });
  if (!plan) { console.log('NO_PLAN', quoteId); return; }
  const route = await prisma.dvi_itinerary_route_details.findFirst({ where: { itinerary_plan_ID: plan.itinerary_plan_ID, deleted: 0, status: 1 }, orderBy: { itinerary_route_ID: 'asc' }, select: { itinerary_route_ID: true, itinerary_route_date: true } });
  const rows = await prisma.$queryRawUnsafe(`
    SELECT route_hotspot_ID, itinerary_route_ID, item_type, hotspot_order, hotspot_ID,
           hotspot_start_time, hotspot_end_time, hotspot_travelling_distance,
           is_conflict, conflict_reason, deleted, status
    FROM dvi_itinerary_route_hotspot_details
    WHERE itinerary_plan_ID = ${plan.itinerary_plan_ID}
      AND itinerary_route_ID = ${route.itinerary_route_ID}
      AND deleted = 0
      AND status = 1
    ORDER BY hotspot_order ASC, item_type ASC, route_hotspot_ID ASC
  `);

  const hotspotIds = [...new Set(rows.map(r => Number(r.hotspot_ID || 0)).filter(Boolean))];
  const masters = hotspotIds.length ? await prisma.dvi_hotspot_place.findMany({ where: { hotspot_ID: { in: hotspotIds } }, select: { hotspot_ID: true, hotspot_name: true, deleted: true } }) : [];
  const m = new Map(masters.map(x => [Number(x.hotspot_ID), x]));

  console.log('\n===', quoteId, 'plan', plan.itinerary_plan_ID, 'route', route.itinerary_route_ID, '===');
  for (const r of rows) {
    const hid = Number(r.hotspot_ID || 0);
    const hm = hid ? m.get(hid) : null;
    console.log([
      `rhs=${r.route_hotspot_ID}`,
      `type=${r.item_type}`,
      `ord=${r.hotspot_order}`,
      `hid=${hid}`,
      `hname=${hm?.hotspot_name || ''}`,
      `hDel=${hm?.deleted ?? ''}`,
      `st=${r.hotspot_start_time}`,
      `en=${r.hotspot_end_time}`,
      `dist=${r.hotspot_travelling_distance}`,
      `conf=${r.is_conflict}`,
      `reason=${r.conflict_reason || ''}`
    ].join(' | '));
  }
}

(async () => {
  await dump('DVI202604225');
  await dump('DVI202604230');
  await prisma.$disconnect();
})().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
