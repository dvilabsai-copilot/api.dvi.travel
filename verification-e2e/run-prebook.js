const axios = require('axios');
const fs = require('fs');
const base = 'http://127.0.0.1:4006/api/v1';
const prebookReq = {
  itinerary_plan_ID: 12,
  hotel_bookings: [
    {
      provider: 'tbo',
      routeId: 140,
      hotelCode: '6102544',
      bookingCode: '6102544!TB!2!TB!cc4b2cde-fb42-11f0-914b-4a620032403f!TB!N!TB!AFF!',
      roomType: 'Deluxe Single Room,1 Double Bed,NonSmoking',
      checkInDate: '2026-04-26',
      checkOutDate: '2026-04-27',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 2907,
      occupancies: [{ adults: 2, children: 0, childrenAges: [] }],
      passengers: [
        { title: 'Mr', firstName: 'Test', lastName: 'Flow', paxType: 1, leadPassenger: true, age: 34, phoneNo: '9876543210', panNo: 'ABCDE1234F', passportNo: 'N1234567' },
        { title: 'Mrs', firstName: 'Test', lastName: 'Flow', paxType: 1, leadPassenger: false, age: 30, phoneNo: '9876543210', panNo: 'ABCDE1234F', passportNo: 'N1234568' }
      ]
    }
  ],
  endUserIp: '127.0.0.1'
};
(async()=>{
  fs.mkdirSync('verification-e2e', { recursive: true });
  fs.writeFileSync('verification-e2e/2-prebook-request.json', JSON.stringify(prebookReq,null,2));
  try {
    const resp = await axios.post(`${base}/itineraries/hotels/prebook`, prebookReq, { timeout: 120000 });
    fs.writeFileSync('verification-e2e/2-prebook-response.json', JSON.stringify(resp.data,null,2));
    console.log('PREBOOK_OK');
    console.log(JSON.stringify(resp.data,null,2));
  } catch (e) {
    const out = e.response?.data || { message: e.message };
    fs.writeFileSync('verification-e2e/2-prebook-response.json', JSON.stringify(out,null,2));
    console.log('PREBOOK_ERR');
    console.log(JSON.stringify(out,null,2));
    process.exit(1);
  }
})();
