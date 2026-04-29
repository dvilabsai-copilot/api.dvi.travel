const auth='Basic '+Buffer.from('Doview:Doview@12345').toString('base64');
const body={
  CheckIn:'2026-06-10',
  CheckOut:'2026-06-11',
  HotelCodes:'1267547',
  GuestNationality:'IN',
  PaxRooms:[{Adults:1,Children:0,ChildrenAges:[]}],
  ResponseTime:23.0,
  IsDetailedResponse:true
};
(async()=>{
  const s=await fetch('https://affiliate.tektravels.com/HotelAPI/Search',{
    method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body)
  });
  const sj=await s.json();
  const hotel=(sj.HotelResult||[])[0]||{};
  const room=(hotel.Rooms||[])[0]||{};
  const bookingCode=room.BookingCode;

  const p=await fetch('https://affiliate.tektravels.com/HotelAPI/PreBook',{
    method:'POST',headers:{Authorization:auth,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({BookingCode:bookingCode,PaymentMode:'Limit'})
  });
  const pj=await p.json();
  const ph=(pj.HotelResult||[])[0]||{};
  const pr=(ph.Rooms||[])[0]||{};

  console.log(JSON.stringify({
    searchStatus:sj?.Status,
    prebookStatus:pj?.Status,
    searchAmenitiesType:Array.isArray(room?.Amenities)?'array':typeof room?.Amenities,
    searchAmenitiesSample:(room?.Amenities||[]).slice(0,8),
    prebookAmenitiesType:Array.isArray(pr?.Amenities)?'array':typeof pr?.Amenities,
    prebookAmenitiesSample:(pr?.Amenities||[]).slice(0,8)
  },null,2));
})();
