const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PLAN_ID = 386;

function toNum(v){ const n=Number(String(v??'').trim()); return Number.isFinite(n)?n:null; }
function hav(lat1,lng1,lat2,lng2){ const R=6371; const dLat=(lat2-lat1)*Math.PI/180; const dLon=(lng2-lng1)*Math.PI/180; const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2; return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }

(async()=>{
  const eligible = await prisma.dvi_itinerary_plan_vendor_eligible_list.findFirst({ where:{itinerary_plan_id:PLAN_ID, itineary_plan_assigned_status:1, deleted:0, status:1}, orderBy:{itinerary_plan_vendor_eligible_ID:'asc'} });
  const vehicle = eligible ? await prisma.dvi_vehicle.findUnique({ where:{ vehicle_id: eligible.vehicle_id }, select:{ vehicle_id:true, vehicle_location_id:true, vendor_id:true, vendor_branch_id:true } }) : null;
  const originLoc = vehicle ? await prisma.dvi_stored_locations.findFirst({ where:{ location_ID: vehicle.vehicle_location_id, deleted:0, status:1 } }) : null;

  console.log('\n=== VEHICLE ORIGIN ===');
  console.log(JSON.stringify({ eligible, vehicle, origin: originLoc ? {
    location_ID: originLoc.location_ID,
    source_location: originLoc.source_location,
    source_location_city: originLoc.source_location_city,
    lat: originLoc.source_location_lattitude,
    lng: originLoc.source_location_longitude,
  } : null }, null, 2));

  const planHotels = await prisma.dvi_itinerary_plan_hotel_details.findMany({
    where:{ itinerary_plan_id:PLAN_ID, deleted:0, status:1 },
    select:{ itinerary_route_id:true, itinerary_route_date:true, hotel_id:true, hotel_code:true, itinerary_route_location:true },
    orderBy:[{itinerary_route_date:'asc'},{itinerary_plan_hotel_details_ID:'asc'}]
  });

  console.log('\n=== SELECTED PLAN HOTELS ===');
  for(const h of planHotels){
    let source='none', name=null, lat=null, lng=null;
    if(Number(h.hotel_id||0)>0){
      const d=await prisma.dvi_hotel.findFirst({ where:{hotel_id:Number(h.hotel_id)}, select:{hotel_name:true, hotel_latitude:true, hotel_longitude:true} });
      if(d){ source='dvi_hotel'; name=d.hotel_name; lat=d.hotel_latitude; lng=d.hotel_longitude; }
    }
    if((lat===null || lng===null) && h.hotel_code){
      const t=await prisma.tbo_hotel_master.findFirst({ where:{tbo_hotel_code:String(h.hotel_code)}, select:{hotel_name:true,hotel_latitude:true,hotel_longitude:true} });
      if(t){ source='tbo_hotel_master'; name=t.hotel_name; lat=t.hotel_latitude; lng=t.hotel_longitude; }
    }
    if((lat===null || lng===null) && h.itinerary_route_location){
      const c=await prisma.dvi_stored_locations.findFirst({ where:{source_location:h.itinerary_route_location,destination_location:h.itinerary_route_location,deleted:0,status:1}, orderBy:{location_ID:'desc'} });
      if(c){ source='city_fallback'; name=c.source_location; lat=c.source_location_lattitude; lng=c.source_location_longitude; }
    }
    console.log(JSON.stringify({route_id:h.itinerary_route_id, source, name, lat, lng, hotel_id:h.hotel_id, hotel_code:h.hotel_code}, null, 2));
  }

  const before = await prisma.$queryRawUnsafe(`SELECT itinerary_plan_vendor_vehicle_details_ID,itinerary_route_id,total_pickup_km,total_running_km,total_siteseeing_km,total_drop_km,total_travelled_km FROM dvi_itinerary_plan_vendor_vehicle_details WHERE itinerary_plan_id=${PLAN_ID} ORDER BY itinerary_route_date,itinerary_route_id,itinerary_plan_vendor_vehicle_details_ID`);
  console.log('\n=== CURRENT VEHICLE ROWS ===');
  console.log(JSON.stringify(before,(k,v)=>typeof v==='bigint'?v.toString():v,2));

  if(originLoc){
    const oLat=toNum(originLoc.source_location_lattitude), oLng=toNum(originLoc.source_location_longitude);
    const city = await prisma.dvi_stored_locations.findFirst({ where:{source_location:'Chennai',destination_location:'Chennai',deleted:0,status:1}, orderBy:{location_ID:'desc'} });
    if(oLat!==null && oLng!==null && city){
      const cLat=toNum(city.source_location_lattitude), cLng=toNum(city.source_location_longitude);
      if(cLat!==null&&cLng!==null){
        const km = hav(oLat,oLng,cLat,cLng)*1.25;
        console.log('\n=== EXPECTED LOCAL FALLBACK (ORIGIN -> CHENNAI CITY) ===');
        console.log(JSON.stringify({billableKm:Number(km.toFixed(2))},null,2));
      }
    }
  }

  console.log('\nReplay API manually with DEBUG_LOCAL_PICKUP_DROP_FIX=true and compare before/after vehicle rows.');
  await prisma.$disconnect();
})();
