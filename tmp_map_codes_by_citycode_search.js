const auth='Basic '+Buffer.from('Doview:Doview@12345').toString('base64');
const codes=['1376565','1345318','1345320','1200255','1128760','1250333','1078234','1347149','1358855','1345321','1108025','1356271','1267547'];
const cityCandidates=[{code:'115936',name:'Dubai?'},{code:'127067',name:'Candidate-127067'}];

async function search(hotelCode, cityCode){
  const body={
    CheckIn:'2026-06-10',CheckOut:'2026-06-11',HotelCodes:hotelCode,CityCode:cityCode,
    GuestNationality:'IN',PaxRooms:[{Adults:1,Children:0,ChildrenAges:[]}],ResponseTime:23.0,IsDetailedResponse:true
  };
  const r=await fetch('https://affiliate.tektravels.com/HotelAPI/Search',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  const rows=Array.isArray(j?.HotelResult)?j.HotelResult:[];
  const hasSupp=rows.some(h=>Array.isArray(h.Rooms)&&h.Rooms.some(r=>Array.isArray(r.Supplements)&&r.Supplements.length>0));
  return {status:j?.Status, count:rows.length, hasSupp};
}

(async()=>{
 const out=[];
 for(const hc of codes){
   const r={hotelCode:hc, byCity:[]};
   for(const c of cityCandidates){
     try{ const s=await search(hc,c.code); r.byCity.push({cityCode:c.code,cityName:c.name,...s}); }
     catch(e){ r.byCity.push({cityCode:c.code,cityName:c.name,error:String(e)}); }
   }
   out.push(r);
 }
 console.log(JSON.stringify(out,null,2));
})();
