const auth='Basic '+Buffer.from('Doview:Doview@12345').toString('base64');

async function post(url, body){
  const r=await fetch(url,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  return j;
}

(async()=>{
  const searchBody={CheckIn:'2026-06-10',CheckOut:'2026-06-11',HotelCodes:'1376565,1345318,1345320,1200255,1128760,1250333,1078234,1347149,1358855,1345321,1108025,1356271,1267547',GuestNationality:'IN',PaxRooms:[{Adults:1,Children:0,ChildrenAges:[]}],ResponseTime:23.0,IsDetailedResponse:true};
  const s=await post('https://affiliate.tektravels.com/HotelAPI/Search',searchBody);
  const hotel=(s.HotelResult||[])[0];
  const bookingCode=hotel?.Rooms?.[0]?.BookingCode;
  const p=await post('https://affiliate.tektravels.com/HotelAPI/PreBook',{BookingCode:bookingCode,PaymentMode:'Limit'});
  console.log(JSON.stringify({bookingCode, prebookKeys:Object.keys(p||{}), hotelKeys: p?.HotelName ? 'hasHotelName': 'no', sample: p}, null, 2));
})();
