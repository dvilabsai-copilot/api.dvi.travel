const itineraryPlanId = Number(process.argv[2] || 9581);

function parseStaahSearchReference(reference) {
  const raw = String(reference || '').trim();
  if (!raw.startsWith('STAAH-')) return null;
  const parts = raw.split('-');
  if (parts.length < 5) return null;
  const propertyId = String(parts[1] || '').trim();
  const roomId = String(parts[2] || '').trim();
  const rateId = String(parts[3] || '').trim();
  if (!propertyId || !roomId || !rateId) return null;
  return { propertyId, roomId, rateId };
}

const latestFailingPayload = {
  itinerary_plan_ID: 9581,
  hotel_bookings: [
    {
      provider: 'staah',
      routeId: 4672,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44588',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-06-18',
      checkOutDate: '2026-06-19',
      netAmount: 1098,
    },
    {
      provider: 'staah',
      routeId: 4673,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44588',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-06-19',
      checkOutDate: '2026-06-20',
      netAmount: 1098,
    },
  ],
};

console.log(`Debugging STAAH confirm mapping for itinerary_plan_ID=${itineraryPlanId}`);

for (const hotel of latestFailingPayload.hotel_bookings) {
  const provider = String(hotel.provider || '').trim().toLowerCase();
  const bookingCode = String(hotel.bookingCode || '').trim() || null;
  const searchReference = String(hotel.searchReference || '').trim() || null;
  const parsedReference =
    parseStaahSearchReference(searchReference) ||
    parseStaahSearchReference(bookingCode);
  const roomId = String(hotel.roomId || parsedReference?.roomId || '').trim() || null;
  const rateId = String(hotel.rateId || parsedReference?.rateId || '').trim() || null;
  const validForStaahConfirm =
    provider === 'staah' &&
    (
      (searchReference && !!parseStaahSearchReference(searchReference)) ||
      (bookingCode && !!parseStaahSearchReference(bookingCode)) ||
      (roomId && rateId)
    )
      ? 'YES'
      : 'NO';

  console.log('---');
  console.log(`routeId=${hotel.routeId}`);
  console.log(`provider=${provider}`);
  console.log(`hotelCode=${hotel.hotelCode}`);
  console.log(`bookingCode=${bookingCode}`);
  console.log(`searchReference=${searchReference}`);
  console.log(`roomId=${roomId}`);
  console.log(`rateId=${rateId}`);
  console.log(`validForStaahConfirm=${validForStaahConfirm}`);
}
