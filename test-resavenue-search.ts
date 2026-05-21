import { PrismaService } from './src/prisma.service';
import { ResAvenueHotelProvider } from './src/modules/hotels/providers/resavenue-hotel.provider';

const prisma = new PrismaService();
const resavenueProvider = new ResAvenueHotelProvider(prisma);

async function main() {
  try {
    console.log('\n🧪 TESTING RESAVENUE SEARCH DIRECTLY\n');

    // Test search for Madurai
    console.log('━━━ Test 1: Searching Madurai ━━━\n');
    
    const maduraiResult = await resavenueProvider.search({
      cityCode: 'Madurai',
      checkInDate: '2026-05-25',
      checkOutDate: '2026-05-26',
      roomCount: 1,
      guestCount: 2,
      occupancies: [{ adults: 2, children: 0 }],
    });

    console.log(`Results for Madurai: ${maduraiResult.length} hotels found`);
    if (maduraiResult.length > 0) {
      maduraiResult.forEach((h) => {
        console.log(`   ✅ ${h.hotelName} (${h.hotelCode}) - ₹${h.price}`);
      });
    }

    // Test search for Rameswaram
    console.log('\n━━━ Test 2: Searching Rameswaram ━━━\n');
    
    const rameshwaramResult = await resavenueProvider.search({
      cityCode: 'Rameswaram',
      checkInDate: '2026-05-25',
      checkOutDate: '2026-05-26',
      roomCount: 1,
      guestCount: 2,
      occupancies: [{ adults: 2, children: 0 }],
    });

    console.log(`Results for Rameswaram: ${rameshwaramResult.length} hotels found`);
    if (rameshwaramResult.length > 0) {
      rameshwaramResult.forEach((h) => {
        console.log(`   ✅ ${h.hotelName} (${h.hotelCode}) - ₹${h.price}`);
      });
    }

    console.log('\n');
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
