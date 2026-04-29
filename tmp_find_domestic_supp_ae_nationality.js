const auth='Basic '+Buffer.from('Doview:Doview@12345').toString('base64');
const cityCode='127067'; // Madurai (domestic)
const hotelCodes=[
'1011651','1013091','1013522','1016336','1016348','1018954','1033444','1033447','1033459','1033462','1033471','1033473','1033475','1033915','1033941','1033943','1033947','1047331','1048435','1048438','1048447','1048448','1048478','1048480','1048496','1048519','1048521','1048536','1057396','1059857','1059858','1059865','1059867','1083502','1083504','1083518','1083522','1083524','1083530','1083544','1083547','1083550','1083554','1083558','1083563','1083565','1083567','1083569','1083571','1083573','1083575','1083577','1083579','1083595','1083598','1083601','1083608','1083629','1083636','1083638','1083643','1083645','1083648','1083650','1083655','1083658','1083665','1083670','1088694','1088712','1088715','1088718','1088731','1088736','1088749','1088751','1089855','1108672','1108722','1110054','1110056','1110057','1110065','1110070','1110073','1110096','1110105','1110106','1124174','1124199','1124202','1124205','1124208','1124211','1124262','1124290','1124298','1124299','1124300','1124301'
];

async function search(code){
  const body={
    CheckIn:'2026-06-10', CheckOut:'2026-06-11',
    HotelCodes: code, CityCode: cityCode,
    GuestNationality:'AE',
    PaxRooms:[{Adults:1,Children:0,ChildrenAges:[]}],
    ResponseTime:23.0, IsDetailedResponse:true
  };
  const r=await fetch('https://affiliate.tektravels.com/HotelAPI/Search',{
    method:'POST',
    headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body)
  });
  const j=await r.json();
  const hotels=Array.isArray(j?.HotelResult)?j.HotelResult:[];
  let hasSupp=false;
  let roomCount=0;
  for(const h of hotels){
    const rooms=Array.isArray(h?.Rooms)?h.Rooms:[];
    roomCount+=rooms.length;
    if(rooms.some(r=>Array.isArray(r?.Supplements)&&r.Supplements.length>0)) hasSupp=true;
  }
  return {status:j?.Status?.Code,desc:j?.Status?.Description,hotelCount:hotels.length,roomCount,hasSupp};
}

(async()=>{
  const results=[];
  for(const code of hotelCodes){
    try{
      const r=await search(code);
      if(r.hasSupp){ results.push({hotelCode:code,...r}); }
    }catch(e){ }
  }
  console.log(JSON.stringify({cityCode,guestNationality:'AE',supplementHotelCount:results.length,results:results.slice(0,30)},null,2));
})();
