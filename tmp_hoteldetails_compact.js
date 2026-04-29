const auth='Basic '+Buffer.from('TBOStaticAPITest:Tbo@11530818').toString('base64');
const BASE='http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const codes=['1376565','1345318','1345320','1200255','1128760','1250333','1078234','1347149','1358855','1345321','1108025','1356271','1267547'];

async function detail(code){
  const r=await fetch(`${BASE}/Hoteldetails`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({Hotelcodes:code,Language:'EN'})});
  return await r.json();
}

(async()=>{
  const out=[];
  for(const code of codes){
    try{
      const j=await detail(code);
      const dRaw=j?.HotelDetails;
      const d=Array.isArray(dRaw)?dRaw[0]:dRaw;
      out.push({
        hotelCode: code,
        statusCode: j?.Status?.Code ?? null,
        statusDescription: j?.Status?.Description ?? null,
        hotelName: d?.HotelName ?? null,
        cityName: d?.CityName ?? null,
        cityId: d?.CityId ?? null,
        countryCode: d?.CountryCode ?? null,
        address: d?.Address ?? null,
      });
    }catch(e){
      out.push({hotelCode:code,error:String(e)});
    }
  }
  console.log(JSON.stringify(out,null,2));
})();
