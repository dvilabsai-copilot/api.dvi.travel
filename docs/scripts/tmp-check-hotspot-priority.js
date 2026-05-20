const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const names = ["Meenakshi Amman Temple", "Thirumalai Nayakkar Mahal"];
  const hotspots = await db.dvi_hotspot_place.findMany({
    where: { hotspot_name: { in: names }, deleted: 0 },
    select: { hotspot_ID: true, hotspot_name: true, hotspot_priority: true, hotspot_duration: true, location_ID: true, status: true }
  });
  console.log(JSON.stringify(hotspots, null, 2));
  await db.$disconnect();
})().catch(async (e) => {
  console.error(e.stack || e);
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
