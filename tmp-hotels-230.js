const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async()=>{
  const quoteId='DVI202604230';
  const plan=await prisma.dvi_itinerary_plan_details.findFirst({where:{itinerary_quote_ID:quoteId,deleted:0},select:{itinerary_plan_ID:true}});
  if(!plan){console.log('no plan');return;}
  console.log('plan',plan.itinerary_plan_ID);
  const hotels=await prisma.dvi_itinerary_plan_hotel_details.findMany({
    where:{itinerary_plan_id:plan.itinerary_plan_ID,deleted:0},
    select:{itinerary_plan_hotel_details_ID:true,itinerary_route_id:true,itinerary_route_date:true,group_type:true,hotel_required:true,hotel_id:true,hotel_code:true,hotel_name:true,total_hotel_cost:true,total_hotel_tax_amount:true,status:true},
    orderBy:[{group_type:'asc'},{itinerary_route_id:'asc'},{itinerary_plan_hotel_details_ID:'asc'}]
  });
  console.log('hotel_detail_rows',hotels.length);
  for(const r of hotels.slice(0,80)){
    console.log(`id=${r.itinerary_plan_hotel_details_ID} route=${r.itinerary_route_id} date=${r.itinerary_route_date?.toISOString?.().slice(0,10)} grp=${r.group_type} req=${r.hotel_required} hid=${r.hotel_id} code=${r.hotel_code||''} name=${r.hotel_name||''} total=${r.total_hotel_cost||0} tax=${r.total_hotel_tax_amount||0} status=${r.status}`);
  }
  await prisma.$disconnect();
})().catch(async e=>{console.error(e);await prisma.$disconnect();process.exit(1);});
