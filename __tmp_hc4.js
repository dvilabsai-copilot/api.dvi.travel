const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const s = (o) => JSON.stringify(o, (k,v) => typeof v==='bigint'?v.toString():v, 2);
(async()=>{
  const cols = await prisma.$queryRawUnsafe("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='dvi_itinerary_route_details' AND COLUMN_NAME LIKE '%hotel%'");
  console.log('HOTEL_COLS:' + s(cols));
  const r = await prisma.$queryRawUnsafe("SELECT * FROM dvi_itinerary_route_details WHERE itinerary_route_ID=4498 LIMIT 1");
  console.log('ROUTE4498:' + s(r));
  const ht = await prisma.$queryRawUnsafe("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME LIKE '%hotel%' OR TABLE_NAME LIKE '%accommodation%')");
  console.log('HOTEL_TABLES:' + s(ht));
  const h = await prisma.$queryRawUnsafe("SELECT hotel_ID,hotel_name,hotel_lat,hotel_lng,hotel_city,hotel_address FROM dvi_hotels WHERE hotel_ID=41404");
  console.log('HOTEL41404:' + s(h));
  const h224 = await prisma.$queryRawUnsafe("SELECT hotspot_ID,hotspot_name,hotspot_lat,hotspot_lng,hotspot_city FROM dvi_hotspots WHERE hotspot_ID=224");
  console.log('HS224:' + s(h224));
  const h483 = await prisma.$queryRawUnsafe("SELECT hotspot_ID,hotspot_name,hotspot_lat,hotspot_lng,hotspot_city FROM dvi_hotspots WHERE hotspot_ID=483");
  console.log('HS483:' + s(h483));
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1);});