const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const hotspots = await db.dvi_hotspot_place.findMany({
    where: {
      OR: [
        { hotspot_name: { in: ["Meenakshi Amman Temple", "Thirumalai Nayakkar Mahal"] } },
        { hotspot_ID: { in: [30, 31, 35, 36, 37, 38, 40, 759] } }
      ],
      deleted: 0
    },
    select: { hotspot_ID: true, hotspot_name: true, hotspot_priority: true, hotspot_duration: true, status: true }
  });
  console.log(JSON.stringify(hotspots, null, 2));
  await db.$disconnect();
})().catch(async (e) => {
  console.error(e.stack || e);
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
