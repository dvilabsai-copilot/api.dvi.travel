const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async()=>{
 const planId=386;
 const eligible=await prisma.dvi_itinerary_plan_vendor_eligible_list.findFirst({where:{itinerary_plan_id:planId,deleted:0},orderBy:{itinerary_plan_vendor_eligible_ID:'asc'}});
 console.log('ELIGIBLE',eligible&&{id:eligible.itinerary_plan_vendor_eligible_ID,vehicle_id:eligible.vehicle_id,vendor_id:eligible.vendor_id});
 const veh=eligible?.vehicle_id?await prisma.dvi_vehicle.findFirst({where:{vehicle_id:eligible.vehicle_id}}):null;
 console.log('VEHICLE',veh&&{vehicle_id:veh.vehicle_id,vehicle_location_id:veh.vehicle_location_id});
 const origin=veh?.vehicle_location_id?await prisma.dvi_stored_locations.findFirst({where:{location_ID:veh.vehicle_location_id}}):null;
 console.log('ORIGIN',origin&&{location_ID:origin.location_ID,source_location:origin.source_location,lat:origin.source_location_lattitude,lng:origin.source_location_longitude});
 const hotels=await prisma.dvi_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,deleted:0},select:{itinerary_route_id:true,hotel_name:true,hotel_id:true,hotel_code:true}});
 console.log('PLAN_HOTELS',hotels);
 const rows=await prisma.dvi_itinerary_plan_vendor_vehicle_details.findMany({where:{itinerary_plan_id:planId,deleted:0},orderBy:[{itinerary_route_date:'asc'},{itinerary_route_id:'asc'}],select:{itinerary_route_id:true,total_pickup_km:true,total_running_km:true,total_siteseeing_km:true,total_drop_km:true,total_travelled_km:true}});
 console.log('VEHICLE_ROWS',rows);
})().catch(console.error).finally(async()=>{await prisma.$disconnect()});
