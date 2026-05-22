const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkPlanPreferences() {
  try {
    console.log('\n🏨 Checking plan 313 preferences...\n');

    const plan = await prisma.dvi_itinerary_plan_details.findFirst({
      where: { itinerary_plan_ID: 313, deleted: 0 },
      select: {
        itinerary_plan_ID: true,
        preferred_hotel_category: true,
        meal_plan_code: true,
        meal_plan_breakfast: true,
        meal_plan_lunch: true,
        meal_plan_dinner: true,
        preferred_room_count: true,
        total_adult: true,
        total_children: true,
        no_of_nights: true,
      },
    });

    if (!plan) {
      console.log('Plan 313 not found!');
    } else {
      console.log('Plan 313 preferences:');
      console.log(`  - preferred_hotel_category: ${plan.preferred_hotel_category}`);
      console.log(`  - meal_plan_code: ${plan.meal_plan_code}`);
      console.log(`  - meal_plan_breakfast: ${plan.meal_plan_breakfast}`);
      console.log(`  - meal_plan_lunch: ${plan.meal_plan_lunch}`);
      console.log(`  - meal_plan_dinner: ${plan.meal_plan_dinner}`);
      console.log(`  - preferred_room_count: ${plan.preferred_room_count}`);
      console.log(`  - total_adult: ${plan.total_adult}`);
      console.log(`  - total_children: ${plan.total_children}`);
      console.log(`  - no_of_nights: ${plan.no_of_nights}`);
    }

    // Check what ResAvenue hotels are in Madurai and Rameswaram and what their categories are
    console.log('\n📭 ResAvenue hotels by city and category:');
    const cities = ['Madurai', 'Rameswaram'];
    for (const city of cities) {
      const hotels = await prisma.dvi_hotel.findMany({
        where: {
          hotel_city: city,
          resavenue_hotel_code: { not: null },
          status: 1,
          deleted: false,
        },
        select: {
          hotel_name: true,
          hotel_category: true,
          resavenue_hotel_code: true,
        },
      });
      console.log(`\n  ${city}:`);
      if (hotels.length === 0) {
        console.log(`    No ResAvenue hotels found!`);
      } else {
        hotels.forEach(h => {
          console.log(`    - ${h.hotel_name} (Category: ${h.hotel_category}*, Code: ${h.resavenue_hotel_code})`);
        });
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkPlanPreferences();
