const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  const targetSession = '8c98cc448a15aa1';

  const hotspot = await prisma.dvi_hotspot_place.findFirst({
    where: { status: 1, deleted: 0, hotspot_name: { not: null }, hotspot_location: { not: null } },
    orderBy: { hotspot_ID: 'desc' },
    select: { hotspot_ID: true, hotspot_name: true, hotspot_location: true },
  });
  const vehicle = await prisma.dvi_vehicle_type.findFirst({
    where: { status: 1, deleted: 0, vehicle_type_title: { not: null } },
    orderBy: { vehicle_type_id: 'asc' },
    select: { vehicle_type_id: true, vehicle_type_title: true },
  });

  if (!hotspot || !vehicle) {
    throw new Error('Missing valid hotspot/vehicle data to patch temp rows');
  }

  const locationToken = String(hotspot.hotspot_location).split('|').map(s => s.trim()).find(Boolean) || String(hotspot.hotspot_location);

  const tempRows = await prisma.dvi_tempcsv.findMany({
    where: { csvtype: 4, sessionID: targetSession },
    orderBy: { temp_id: 'asc' },
    select: { temp_id: true, field4: true, status: true, field5: true },
  });

  if (!tempRows.length) {
    throw new Error(`No rows found for session ${targetSession}`);
  }

  for (const r of tempRows) {
    const charge = Number(r.field4 || 0) > 0 ? String(Math.round(Number(r.field4))) : '100';
    await prisma.dvi_tempcsv.update({
      where: { temp_id: r.temp_id },
      data: {
        field1: hotspot.hotspot_name,
        field2: locationToken,
        field3: vehicle.vehicle_type_title,
        field4: charge,
        field5: null,
        status: 1,
      },
    });
  }

  const patched = await prisma.dvi_tempcsv.findMany({
    where: { csvtype: 4, sessionID: targetSession },
    orderBy: { temp_id: 'asc' },
    select: { temp_id: true, field1: true, field2: true, field3: true, field4: true, status: true },
  });

  console.log(JSON.stringify({
    session: targetSession,
    hotspot: { id: hotspot.hotspot_ID, name: hotspot.hotspot_name, locationToken },
    vehicle: { id: vehicle.vehicle_type_id, name: vehicle.vehicle_type_title },
    patchedRows: patched,
  }, null, 2));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
