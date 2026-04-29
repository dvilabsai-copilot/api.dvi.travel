const auth='Basic '+Buffer.from('TBOStaticAPITest:Tbo@11530818').toString('base64');
const BASE='http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const codes=['1376565','1345318','1345320','1200255','1128760','1250333','1078234','1347149','1358855','1345321','1108025','1356271','1267547'];

async function detail(code){
 const r=await fetch(`${BASE}/Hoteldetails`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({Hotelcodes:code,Language:'EN'})});
 const j=await r.json();
 return j;
}

(async()=>{
 const out=[];
 for(const c of codes){
   try{
     const j=await detail(c);
     const d=j?.HotelDetails || j?.HotelDetail || null;
     const arr=Array.isArray(d)?d:(d?[d]:[]);
     out.push({hotelCode:c,status:j?.Status||null,count:arr.length,sample:arr[0]||null});
   }catch(e){out.push({hotelCode:c,error:String(e)});}
 }
 console.log(JSON.stringify(out,null,2));
})();
