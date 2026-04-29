const auth='Basic '+Buffer.from('Doview:Doview@12345').toString('base64');
const body={
  CheckIn:'2026-06-10',
  CheckOut:'2026-06-11',
  HotelCodes:'1376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547',
  GuestNationality:'IN',
  PaxRooms:[{Adults:1,Children:0,ChildrenAges:[]}],
  ResponseTime:23.0,
  IsDetailedResponse:true
};

function keys(obj,prefix='',out=[]){
 if(Array.isArray(obj)){if(obj.length) keys(obj[0],prefix+'[]',out); return out;}
 if(obj&&typeof obj==='object'){ for(const k of Object.keys(obj)){ out.push(prefix?`${prefix}.${k}`:k); keys(obj[k],prefix?`${prefix}.${k}`:k,out);} }
 return out;
}

(async()=>{
 const r=await fetch('https://affiliate.tektravels.com/HotelAPI/Search',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();
 const hr=Array.isArray(j.HotelResult)?j.HotelResult:[];
 const first=hr[0]||{};
 console.log(JSON.stringify({count:hr.length, firstKeys:[...new Set(keys(first))].slice(0,150), first},null,2));
})();
