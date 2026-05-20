const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
function formatTime(value) {
  if (!value) return null;
  const d = new Date(value);
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${String(h12).padStart(2,'0')}:${String(minutes).padStart(2,'0')} ${suffix}`;
}
function timeToMinutes(text) {
  const m = String(text).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  let h = Number(m[1]) % 12;
  const min = Number(m[2]);
  const mer = m[3].toUpperCase();
  if (mer === 'PM') h += 12;
  return h * 60 + min;
}
(async () => {
  const rows = await db.dvi_itinerary_route_hotspot_details.findMany({
    where: { itinerary_plan_ID: 379, itinerary_route_ID: 3967, deleted: 0, status: 1 }
  });
  rows.sort((a, b) => {
    const aStart = formatTime(a.hotspot_start_time ?? null);
    const bStart = formatTime(b.hotspot_start_time ?? null);
    const aStartMins = aStart ? timeToMinutes(aStart) : Number.MAX_SAFE_INTEGER;
    const bStartMins = bStart ? timeToMinutes(bStart) : Number.MAX_SAFE_INTEGER;
    if (aStartMins !== bStartMins) return aStartMins - bStartMins;
    const aEnd = formatTime(a.hotspot_end_time ?? null);
    const bEnd = formatTime(b.hotspot_end_time ?? null);
    const aEndMins = aEnd ? timeToMinutes(aEnd) : Number.MAX_SAFE_INTEGER;
    const bEndMins = bEnd ? timeToMinutes(bEnd) : Number.MAX_SAFE_INTEGER;
    if (aEndMins !== bEndMins) return aEndMins - bEndMins;
    const itemDiff = Number(a.item_type ?? 0) - Number(b.item_type ?? 0);
    if (itemDiff !== 0) return itemDiff;
    return Number(a.hotspot_order ?? 0) - Number(b.hotspot_order ?? 0);
  });
  console.log(JSON.stringify(rows.map(r => ({
    route_hotspot_ID: r.route_hotspot_ID,
    hotspot_order: r.hotspot_order,
    item_type: r.item_type,
    hotspot_ID: r.hotspot_ID,
    start: formatTime(r.hotspot_start_time),
    end: formatTime(r.hotspot_end_time)
  })), null, 2));
  await db.$disconnect();
})().catch(async (e) => { console.error(e.stack || e); try { await db.$disconnect(); } catch {} process.exit(1); });
