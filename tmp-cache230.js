const { PrismaClient } = require("@prisma/client");
const p=new PrismaClient();
(async()=>{
  const quote='DVI202604230';
  const rows=await p.dvi_itinerary_hotel_search_cache.findMany({
    where:{quote_id:quote,deleted:0,status:1},
    select:{route_id:true,group_type:true,hotel_name:true,provider:true,price:true,sort_rank:true,search_reference:true},
    orderBy:[{group_type:'asc'},{route_id:'asc'},{sort_rank:'asc'}]
  });
  console.log('cache rows',rows.length);
  const grp={};
  for(const r of rows){
    const k=`g${r.group_type}-r${r.route_id}`;
    if(!grp[k]) grp[k]={count:0,placeholder:0,providers:new Set(),top:[]};
    grp[k].count++;
    if(String(r.hotel_name||'').toLowerCase().includes('no hotels available')) grp[k].placeholder++;
    grp[k].providers.add(r.provider||'');
    if((r.sort_rank||0)<=3) grp[k].top.push(`${r.sort_rank}:${r.hotel_name}|${r.price}`);
  }
  Object.entries(grp).forEach(([k,v])=>{
    console.log(k,'count',v.count,'placeholder',v.placeholder,'providers',[...v.providers].join(','),'top',v.top.join(' || '));
  });
  await p.$disconnect();
})().catch(async e=>{console.error(e);await p.$disconnect();process.exit(1);});
