
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agent = await prisma.dvi_agent.findFirst({ where: { deleted: 0 } });
  const hotelCat = await prisma.dvi_hotel_category.findFirst({ where: { deleted: 0 } });
  const state = await prisma.dvi_states.findFirst({ where: { deleted: 0 } });
  const city = await prisma.dvi_cities.findFirst({ where: { deleted: 0 } });
  const vehicleType = await prisma.dvi_vehicle_type.findFirst({ where: { deleted: 0 } });

 console.log('IDs:', {
    agent_id: agent?.agent_ID,
    hotel_category_id: hotelCat?.hotel_category_id,
    state_id: state?.id,
    city_id: city?.id,
    vehicle_type_id: vehicleType?.vehicle_type_id
  });
}

main()
 .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
