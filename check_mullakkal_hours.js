const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get operating hours for Mullakkal temple (hotspot ID 487)
  const timings = await prisma.dvi_hotspot_timing.findMany({
    where: { hotspot_ID: 487, deleted: 0, status: 1 },
    select: { hotspot_timing_day: true, hotspot_start_time: true, hotspot_end_time: true }
  });
  
  console.log('=== MULLAKKAL TEMPLE OPERATING HOURS ===');
  timings.forEach(t => {
    const start = new Date(t.hotspot_start_time);
    const end = new Date(t.hotspot_end_time);
    console.log(`Day ${t.hotspot_timing_day}:`);
    console.log(`  Start: ${t.hotspot_start_time} (${start.getUTCHours()}:${String(start.getUTCMinutes()).padStart(2, '0')} UTC)`);
    console.log(`  End: ${t.hotspot_end_time} (${end.getUTCHours()}:${String(end.getUTCMinutes()).padStart(2, '0')} UTC)`);
  });
  
  await prisma.$disconnect();
}

main().catch(console.error);
