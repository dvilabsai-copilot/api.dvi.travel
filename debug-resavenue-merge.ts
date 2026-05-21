import { PrismaService } from './src/prisma.service';
import { ItineraryHotelDetailsTboService } from './src/modules/itineraries/itinerary-hotel-details-tbo.service';

async function main() {
  const prisma = new PrismaService();
  const service = new ItineraryHotelDetailsTboService(
    prisma,
    null as any, // Not using hotel details service
  );

  try {
    console.log('\n🔍 DEBUGGING RESAVENUE FETCH FOR DVI20260521\n');

    const result = await service.getHotelDetailsByQuoteIdFromTbo('DVI20260521');

    console.log('\n📊 FINAL RESPONSE ANALYSIS:');
    console.log(`Total hotels: ${result.hotels?.length || 0}`);
    
    const byProvider = new Map<string, number>();
    result.hotels?.forEach((h: any) => {
      const provider = h.provider || 'unknown';
      byProvider.set(provider, (byProvider.get(provider) || 0) + 1);
    });

    console.log('\nHotels by provider:');
    byProvider.forEach((count, provider) => {
      console.log(`  ${provider}: ${count}`);
    });

    // Check routes
    const routes = result.hotels?.map((h: any) => h.destination) || [];
    const uniqueRoutes = new Set(routes);
    console.log(`\nDestinations: ${Array.from(uniqueRoutes).join(', ')}`);

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
