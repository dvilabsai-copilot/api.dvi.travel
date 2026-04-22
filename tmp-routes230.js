const { PrismaClient } = require("@prisma/client");
const p=new PrismaClient();
(async()=>{
 const plan=await p.dvi_itinerary_plan_details.findFirst({where:{itinerary_quote_ID:'DVI202604230',deleted:0},select:{itinerary_plan_ID:true,no_of_days:true,no_of_nights:true}});
 const routes=await p.dvi_itinerary_route_details.findMany({where:{itinerary_plan_ID:plan.itinerary_plan_ID,deleted:0},select:{itinerary_route_ID:true,itinerary_route_date:true,location_name:true,next_visiting_location:true},orderBy:{itinerary_route_date:'asc'}});
 console.log('plan',plan);
 routes.forEach((r,i)=>console.log(`idx=${i} route=${r.itinerary_route_ID} date=${r.itinerary_route_date.toISOString().slice(0,10)} loc=${r.location_name||''} next=${r.next_visiting_location||''}`));
 await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1);});
