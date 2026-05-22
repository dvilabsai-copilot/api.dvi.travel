import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('\n🏨 CHECKING RESAVENUE HOTELS IN DATABASE...\n');

    // Query all hotels with resavenue_hotel_code
    const resavenueHotels = await prisma.dvi_hotel.findMany({
      where: {
        resavenue_hotel_code: { not: null },
        deleted: false,
        status: 1,
      },
      select: {
        hotel_id: true,
        hotel_name: true,
        hotel_code: true,
        resavenue_hotel_code: true,
        hotel_city: true,
        hotel_state: true,
        hotel_country: true,
        hotel_category: true,
        status: true,
      },
      orderBy: [
        { hotel_city: 'asc' },
        { hotel_name: 'asc' },
      ],
    });

    if (resavenueHotels.length === 0) {
      console.log('❌ No ResAvenue hotels found in database\n');
    } else {
      console.log(`✅ Found ${resavenueHotels.length} ResAvenue hotel(s)\n`);
      console.log('┌────────┬──────────────────────────────┬──────────────────────┬──────────────┬────────────────┬─────┐');
      console.log('│ ID     │ Hotel Name                   │ ResAvenue Code       │ City         │ Category       │ St. │');
      console.log('├────────┼──────────────────────────────┼──────────────────────┼──────────────┼────────────────┼─────┤');
      
      resavenueHotels.forEach((hotel) => {
        const starRating = hotel.hotel_category ? `${hotel.hotel_category}*` : 'N/A';
        const nameDisplay = (hotel.hotel_name || '').substring(0, 28).padEnd(28);
        const codeDisplay = (hotel.resavenue_hotel_code || '').padEnd(20);
        const cityDisplay = (hotel.hotel_city || '').substring(0, 12).padEnd(12);
        const categoryDisplay = starRating.padEnd(14);
        
        console.log(`│ ${String(hotel.hotel_id).padEnd(6)} │ ${nameDisplay} │ ${codeDisplay} │ ${cityDisplay} │ ${categoryDisplay} │ ${hotel.status}   │`);
      });
      
      console.log('└────────┴──────────────────────────────┴──────────────────────┴──────────────┴────────────────┴─────┘\n');

      // Summary by city
      const byCity = new Map<string, number>();
      resavenueHotels.forEach((hotel) => {
        const city = hotel.hotel_city || 'Unknown';
        byCity.set(city, (byCity.get(city) || 0) + 1);
      });

      console.log('📊 Hotels by City:');
      Array.from(byCity.entries())
        .sort((a, b) => b[1] - a[1])
        .forEach(([city, count]) => {
          console.log(`   - ${city}: ${count} hotel(s)`);
        });
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error querying database:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
