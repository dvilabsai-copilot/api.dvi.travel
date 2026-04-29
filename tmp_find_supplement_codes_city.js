const STATIC_USER='TBOStaticAPITest';
const STATIC_PASS='Tbo@11530818';
const auth='Basic '+Buffer.from(`${STATIC_USER}:${STATIC_PASS}`).toString('base64');
const BASE='http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const targetCodes=['1376565','1345318','1345320','1200255','1128760','1250333','1078234','1347149','1358855','1345321','1108025','1356271','1267547'];
const targetSet=new Set(targetCodes);

async function post(path,body){
 const r=await fetch(`${BASE}/${path}`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();
 return j;
}

(async()=>{
 const cityResp=await post('CityList',{CountryCode:'AE'});
 const citiesRaw=Array.isArray(cityResp?.CityList)?cityResp.CityList:(cityResp?.CityList?[cityResp.CityList]:[]);
 const cities=citiesRaw.map(c=>({cityCode:String(c.CityCode||c.Code||''),cityName:String(c.CityName||c.Name||'')})).filter(c=>c.cityCode);

 const found=[];
 const byCode={};
 for(const code of targetCodes){byCode[code]=[];}

 for(const city of cities){
   let hotelResp;
   try { hotelResp=await post('TBOHotelCodeList',{CityCode:city.cityCode}); }
   catch(e){ continue; }
   const list=Array.isArray(hotelResp?.HotelCodeList)?hotelResp.HotelCodeList:(hotelResp?.HotelCodeList?[hotelResp.HotelCodeList]:[]);
   for(const h of list){
     const hc=String(h.HotelCode||h.hotelCode||'').trim();
     if(!targetSet.has(hc)) continue;
     const row={hotelCode:hc,cityCode:city.cityCode,cityName:city.cityName,hotelName:String(h.HotelName||h.hotelName||'').trim()||null};
     found.push(row);
     byCode[hc].push(row);
   }
 }

 const missing=targetCodes.filter(c=>!byCode[c]||byCode[c].length===0);
 console.log(JSON.stringify({cityCount:cities.length,foundCount:found.length,byCode,missing},null,2));
})();
