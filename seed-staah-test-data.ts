// FILE: seed-staah-test-data.ts
// Run this script to seed test data for STAAH integration
// Usage: npx ts-node seed-staah-test-data.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STAAH_PROPERTY_ID = 'STAAH_TEST_HOTEL_1';
const HOTEL_CODE = 'TEST_DVI_001';

async function main() {
  console.log('Seeding STAAH test data...');

  // Step 1: Find or create a test hotel in dvi_hotel
  let testHotel = await prisma.dvi_hotel.findFirst({
    where: {
      staah_property_id: STAAH_PROPERTY_ID,
    },
  });

  if (!testHotel) {
    const existingHotel = await prisma.dvi_hotel.findFirst({
      where: {
        hotel_code: HOTEL_CODE,
      },
    });

    if (existingHotel) {
      testHotel = await prisma.dvi_hotel.update({
        where: { hotel_id: existingHotel.hotel_id },
        data: {
          staah_property_id: STAAH_PROPERTY_ID,
          staah_enabled: 1,
          status: 1,
        },
      });
      console.log('Updated existing hotel with STAAH mapping');
    } else {
      testHotel = await prisma.dvi_hotel.create({
        data: {
          hotel_code: HOTEL_CODE,
          hotel_name: 'Test Hotel for STAAH',
          hotel_address: '123 Test Street',
          hotel_city: 'Test City',
          hotel_state: 'Test State',
          hotel_country: 'India',
          hotel_category: 1,
          staah_property_id: STAAH_PROPERTY_ID,
          staah_enabled: 1,
          status: 1,
        },
      });
      console.log('Created new test hotel with STAAH mapping');
    }
  } else {
    // Ensure enabled flag stays on for test runs
    testHotel = await prisma.dvi_hotel.update({
      where: { hotel_id: testHotel.hotel_id },
      data: {
        staah_enabled: 1,
        status: 1,
      },
    });
    console.log('Test hotel already exists; mapping refreshed');
  }

  // Step 2: Seed room types
  const deluxeRoomType = await prisma.dvi_hotel_roomtype.upsert({
    where: { room_type_id: 9997 },
    update: {
      room_type_title: 'Deluxe Room',
      status: 1,
      deleted: 0,
    },
    create: {
      room_type_id: 9997,
      room_type_title: 'Deluxe Room',
      status: 1,
      deleted: 0,
      createdby: 1,
    },
  });

  const suiteRoomType = await prisma.dvi_hotel_roomtype.upsert({
    where: { room_type_id: 9996 },
    update: {
      room_type_title: 'Suite Room',
      status: 1,
      deleted: 0,
    },
    create: {
      room_type_id: 9996,
      room_type_title: 'Suite Room',
      status: 1,
      deleted: 0,
      createdby: 1,
    },
  });

  console.log('Seeded 2 room types');

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

  console.log('Seeded 2 rooms in dvi_hotel_rooms');

  // Step 4: Seed staah_rateplan
  await prisma.staah_rateplan.upsert({
    where: {
      staah_property_id_room_id_rateplan_id: {
        staah_property_id: STAAH_PROPERTY_ID,
        room_id: 'DELUXE_ROOM',
        rateplan_id: 'CP_PLAN',
      },
    },
    update: {
      rateplan_name: 'Continental Plan',
      occupancy: ['SINGLE', 'DOUBLE', 'TRIPLE'],
      commission_perc: '10.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
    create: {
      staah_property_id: STAAH_PROPERTY_ID,
      room_id: 'DELUXE_ROOM',
      rateplan_id: 'CP_PLAN',
      rateplan_name: 'Continental Plan',
      occupancy: ['SINGLE', 'DOUBLE', 'TRIPLE'],
      commission_perc: '10.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
  });

  await prisma.staah_rateplan.upsert({
    where: {
      staah_property_id_room_id_rateplan_id: {
        staah_property_id: STAAH_PROPERTY_ID,
        room_id: 'SUITE_ROOM',
        rateplan_id: 'MAP_PLAN',
      },
    },
    update: {
      rateplan_name: 'Modified American Plan',
      occupancy: ['SINGLE', 'DOUBLE'],
      commission_perc: '12.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
    create: {
      staah_property_id: STAAH_PROPERTY_ID,
      room_id: 'SUITE_ROOM',
      rateplan_id: 'MAP_PLAN',
      rateplan_name: 'Modified American Plan',
      occupancy: ['SINGLE', 'DOUBLE'],
      commission_perc: '12.0',
      tax_perc: '5.0',
      currency: 'INR',
    },
  });

  console.log('Seeded 2 STAAH rate plans');

  console.log('\nSeeding complete.');
  console.log('Test Data Summary:');
  console.log('==================');
  console.log(`Property ID: ${STAAH_PROPERTY_ID}`);
  console.log(`Hotel: ${testHotel.hotel_name}`);
  console.log('Rooms: DELUXE_ROOM, SUITE_ROOM');
  console.log('Rate Plans: CP_PLAN, MAP_PLAN');
  console.log('\nYou can now test STAAH endpoints with:');
  console.log(`  propertyId: \"${STAAH_PROPERTY_ID}\"`);
  console.log('  roomId: "DELUXE_ROOM" or "SUITE_ROOM"');
  console.log('  rateplanId: "CP_PLAN" or "MAP_PLAN"');
}

main()
  .catch((e) => {
    console.error('Error seeding STAAH data:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
