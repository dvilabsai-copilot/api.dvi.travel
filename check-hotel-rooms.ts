// Check if hotel has rooms
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkHotel() {
  const propertyId = 'AX_la-sara-inn_bengaluru_11488912';
  
  // Find hotel
  const hotel = await prisma.dvi_hotel.findFirst({
    where: {
      axisrooms_property_id: propertyId,
      deleted: { not: true },
    },
  });
  
  if (!hotel) {
    console.log('❌ Hotel not found');
    return;
  }
  
  console.log('✅ Hotel found:');
  console.log(`   ID: ${hotel.hotel_id}`);
  console.log(`   Name: ${hotel.hotel_name}`);
  console.log(`   Property ID: ${hotel.axisrooms_property_id}`);
  console.log(`   Enabled: ${hotel.axisrooms_enabled}`);
  
  // Check rooms
  const rooms = await prisma.dvi_hotel_rooms.findMany({
    where: {
      hotel_id: hotel.hotel_id,
    },
  });
  
  console.log(`\n📊 Total rooms: ${rooms.length}`);
  
  if (rooms.length > 0) {
    console.log('\nRooms:');
    rooms.forEach((r, i) => {
      console.log(`   ${i+1}. ${r.room_title} (ID: ${r.room_ID}, deleted: ${r.deleted}, status: ${r.status})`);
    });
  } else {
    console.log('\n❌ No rooms found for this hotel!');
    console.log('\n💡 Solution: This hotel was imported from Excel but has no rooms yet.');
    console.log('   Use the test property instead: AX_TEST_1');
  }
  
  await prisma.$disconnect();
}

checkHotel().catch(console.error);
