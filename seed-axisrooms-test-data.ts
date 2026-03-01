// FILE: seed-axisrooms-test-data.ts
// Run this script to seed test data for AxisRooms integration
// Usage: npx ts-node seed-axisrooms-test-data.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding AxisRooms test data...');

  // Step 1: Find or create a test hotel in dvi_hotel
  let testHotel = await prisma.dvi_hotel.findFirst({
    where: {
      axisrooms_property_id: 'AX_TEST_1',
    },
  });

  if (!testHotel) {
    // Try to update an existing hotel or create a new one
    const existingHotel = await prisma.dvi_hotel.findFirst({
      where: {
        hotel_code: 'TEST_DVI_001',
      },
    });

    if (existingHotel) {
      testHotel = await prisma.dvi_hotel.update({
        where: { hotel_id: existingHotel.hotel_id },
        data: {
          axisrooms_property_id: 'AX_TEST_1',
          axisrooms_enabled: 1,
        },
      });
      console.log('✅ Updated existing hotel with AxisRooms mapping');
    } else {
      // Create a new test hotel
      testHotel = await prisma.dvi_hotel.create({
        data: {
          hotel_code: 'TEST_DVI_001',
          hotel_name: 'Test Hotel for AxisRooms',
          hotel_address: '123 Test Street',
          hotel_city: 'Test City',
          hotel_state: 'Test State',
          hotel_country: 'India',
          hotel_category: 1,
          axisrooms_property_id: 'AX_TEST_1',
          axisrooms_enabled: 1,
          status: 1,
        },
      });
      console.log('✅ Created new test hotel with AxisRooms mapping');
    }
  } else {
    console.log('✅ Test hotel already exists');
  }

  // Step 2: Seed dvi_hotel_roomtype (room types)
  const deluxeRoomType = await prisma.dvi_hotel_roomtype.upsert({
    where: { room_type_id: 9999 }, // Using a test ID
    update: {
      room_type_title: 'Deluxe Room',
      status: 1,
      deleted: 0,
    },
    create: {
      room_type_id: 9999,
      room_type_title: 'Deluxe Room',
      status: 1,
      deleted: 0,
      createdby: 1,
    },
  });

  const suiteRoomType = await prisma.dvi_hotel_roomtype.upsert({
    where: { room_type_id: 9998 },
    update: {
      room_type_title: 'Suite Room',
      status: 1,
      deleted: 0,
    },
    create: {
      room_type_id: 9998,
      room_type_title: 'Suite Room',
      status: 1,
      deleted: 0,
      createdby: 1,
    },
  });

  console.log('✅ Seeded 2 room types');

  // Step 3: Seed dvi_hotel_rooms
  const existingDeluxeRoom = await prisma.dvi_hotel_rooms.findFirst({
    where: {
      hotel_id: testHotel.hotel_id,
      room_ref_code: 'DELUXE_ROOM',
    },
  });

  if (!existingDeluxeRoom) {
    await prisma.dvi_hotel_rooms.create({
      data: {
        hotel_id: testHotel.hotel_id,
        room_type_id: deluxeRoomType.room_type_id,
        room_title: 'Deluxe Room - Test',
        room_ref_code: 'DELUXE_ROOM',
        no_of_rooms_available: 10,
        total_max_adults: 2,
        total_max_childrens: 1,
        status: 1,
        deleted: 0,
        createdby: 1,
      },
    });
  }

  const existingSuiteRoom = await prisma.dvi_hotel_rooms.findFirst({
    where: {
      hotel_id: testHotel.hotel_id,
      room_ref_code: 'SUITE_ROOM',
    },
  });

  if (!existingSuiteRoom) {
    await prisma.dvi_hotel_rooms.create({
      data: {
        hotel_id: testHotel.hotel_id,
        room_type_id: suiteRoomType.room_type_id,
        room_title: 'Suite Room - Test',
        room_ref_code: 'SUITE_ROOM',
        no_of_rooms_available: 5,
        total_max_adults: 4,
        total_max_childrens: 2,
        status: 1,
        deleted: 0,
        createdby: 1,
      },
    });
  }

  console.log('✅ Seeded 2 rooms in dvi_hotel_rooms');

  // Step 4: Seed axisrooms_room (for backward compatibility with rate plans)
  const room1 = await prisma.axisrooms_room.upsert({
    where: {
      axisrooms_property_id_room_id: {
        axisrooms_property_id: 'AX_TEST_1',
        room_id: 'DELUXE_ROOM',
      },
    },
    update: {},
    create: {
      axisrooms_property_id: 'AX_TEST_1',
      room_id: 'DELUXE_ROOM',
      room_name: 'Deluxe Room',
    },
  });

  const room2 = await prisma.axisrooms_room.upsert({
    where: {
      axisrooms_property_id_room_id: {
        axisrooms_property_id: 'AX_TEST_1',
        room_id: 'SUITE_ROOM',
      },
    },
    update: {},
    create: {
      axisrooms_property_id: 'AX_TEST_1',
      room_id: 'SUITE_ROOM',
      room_name: 'Suite Room',
    },
  });

  console.log('✅ Seeded 2 rooms');

  // Step 5: Seed axisrooms_rateplan
  const rateplan1 = await prisma.axisrooms_rateplan.upsert({
    where: {
      axisrooms_property_id_room_id_rateplan_id: {
        axisrooms_property_id: 'AX_TEST_1',
        room_id: 'DELUXE_ROOM',
        rateplan_id: 'CP_PLAN',
      },
    },
    update: {},
    create: {
      axisrooms_property_id: 'AX_TEST_1',
      room_id: 'DELUXE_ROOM',
      rateplan_id: 'CP_PLAN',
      rateplan_name: 'Continental Plan',
      occupancy: ['SINGLE', 'DOUBLE', 'TRIPLE'],
      commission_perc: '10.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
  });

  const rateplan2 = await prisma.axisrooms_rateplan.upsert({
    where: {
      axisrooms_property_id_room_id_rateplan_id: {
        axisrooms_property_id: 'AX_TEST_1',
        room_id: 'DELUXE_ROOM',
        rateplan_id: 'MAP_PLAN',
      },
    },
    update: {},
    create: {
      axisrooms_property_id: 'AX_TEST_1',
      room_id: 'DELUXE_ROOM',
      rateplan_id: 'MAP_PLAN',
      rateplan_name: 'Modified American Plan',
      occupancy: ['SINGLE', 'DOUBLE'],
      commission_perc: '12.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
  });

  console.log('✅ Seeded 2 rate plans');

  console.log('\n✨ Seeding complete!');
  console.log('\nTest Data Summary:');
  console.log('==================');
  console.log(`Property ID: AX_TEST_1`);
  console.log(`Hotel: ${testHotel.hotel_name}`);
  console.log(`Rooms: DELUXE_ROOM, SUITE_ROOM`);
  console.log(`Rate Plans: CP_PLAN, MAP_PLAN`);
  console.log('\nYou can now test AxisRooms endpoints with:');
  console.log(`  propertyId: "AX_TEST_1"`);
  console.log(`  roomId: "DELUXE_ROOM" or "SUITE_ROOM"`);
  console.log(`  rateplanId: "CP_PLAN" or "MAP_PLAN"`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
