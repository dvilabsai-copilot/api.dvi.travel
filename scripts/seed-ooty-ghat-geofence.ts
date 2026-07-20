import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const sourceReference = {
  restrictionType: 'route_segment_time',
  ghatName: 'Kallar-Coonoor Ghat Road',
  roadNumber: 'NH 181',
  routeVia: ['Mettupalayam', 'Kallar', 'Burliar', 'Coonoor', 'Ooty'],
  detectionRadiusMetres: 700,
  forwardDirection: {
    route: 'Coimbatore to Ooty',
    entry: { name: 'Kallar Mountain Base / Kallar Forest Checkpost', latitude: 11.3371457, longitude: 76.8701544 },
    exit: { name: 'Lower Coonoor / Coonoor Railway Station', latitude: 11.343714, longitude: 76.791337 },
  },
  reverseDirection: {
    route: 'Ooty to Coimbatore',
    entry: { name: 'Lower Coonoor / Coonoor Railway Station', latitude: 11.343714, longitude: 76.791337 },
    exit: { name: 'Kallar Mountain Base / Kallar Forest Checkpost', latitude: 11.3371457, longitude: 76.8701544 },
  },
  routeBoundaries: {
    '15638': { direction: 'FORWARD', ghatStart: { name: 'Kallar Mountain Base / Kallar Forest Checkpost', latitude: 11.3371457, longitude: 76.8701544, detectionRadiusMetres: 700 } },
    '15639': { direction: 'REVERSE', ghatStart: { name: 'Lower Coonoor / Coonoor Railway Station', latitude: 11.343714, longitude: 76.791337, detectionRadiusMetres: 700 } },
  },
  sourceNotes: 'Operational geofence supplied for NH 181 Kallar-Coonoor ghat-road timing checks.',
};

async function main() {
  const result = await prisma.dvi_route_vehicle_restrictions.updateMany({
    where: { rule_code: 'OOTY_GHAT_AFTER_18_ALL_VEHICLES', deleted: 0 },
    data: { source_reference: JSON.stringify(sourceReference), last_verified_on: new Date() },
  });
  if (!result.count) throw new Error('OOTY_GHAT_AFTER_18_ALL_VEHICLES was not found');
  console.log(`Seeded ${result.count} Ooty restriction rule(s) with directional geofence coordinates.`);
}

main().finally(() => prisma.$disconnect());
