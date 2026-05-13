const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
function formatTime(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  return `${String(displayHours).padStart(2,'0')}:${String(minutes).padStart(2,'0')} ${suffix}`;
}
(async () => {
  const row = await db.dvi_itinerary_route_hotspot_details.findFirst({ where: { route_hotspot_ID: 124155 } });
  console.log(JSON.stringify({
    route_hotspot_ID: row.route_hotspot_ID,
    rawStart: row.hotspot_start_time,
    rawEnd: row.hotspot_end_time,
    formattedStart: formatTime(row.hotspot_start_time),
    formattedEnd: formatTime(row.hotspot_end_time)
  }, null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
