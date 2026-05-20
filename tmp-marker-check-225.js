const { PrismaClient } = require("@prisma/client");
const p=new PrismaClient();
(async()=>{
  const q='DVI202604225';
  const plan=await p.dvi_itinerary_plan_details.findFirst({where:{itinerary_quote_ID:q,deleted:0},select:{itinerary_plan_ID:true}});
  const route=await p.dvi_itinerary_route_details.findFirst({where:{itinerary_plan_ID:plan.itinerary_plan_ID,deleted:0,status:1},orderBy:{itinerary_route_ID:'asc'},select:{itinerary_route_ID:true,itinerary_route_date:true,route_start_time:true}});
  const markers=await p.dvi_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:plan.itinerary_plan_ID,itinerary_route_id:route.itinerary_route_ID,hotel_required:2,hotel_id:0,deleted:0},orderBy:{itinerary_plan_hotel_details_ID:'desc'},select:{itinerary_plan_hotel_details_ID:true,group_type:true,itinerary_route_date:true,status:true}});
  console.log('plan',plan.itinerary_plan_ID,'route',route.itinerary_route_ID,'start',route.route_start_time,'markers',JSON.stringify(markers));
  await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1)});
