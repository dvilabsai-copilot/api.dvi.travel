const quoteId = process.argv[2] || process.env.QUOTE_ID;
const token = process.argv[3] || process.env.AUTH_TOKEN;
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4006';

if (!quoteId) {
  console.error('Usage: node scripts/fetch-itinerary-hotel-details.js <quoteId> [bearerToken]');
  console.error('Or set QUOTE_ID and AUTH_TOKEN env vars.');
  process.exit(1);
}

if (!token) {
  console.error('Missing bearer token. Pass it as the second argument or set AUTH_TOKEN.');
  process.exit(1);
}

async function main() {
  const rebuildUrl = `${baseUrl}/api/v1/itineraries/hotel_details/${encodeURIComponent(quoteId)}/rebuild?page=1&pageSize=500`;
  const response = await fetch(rebuildUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const hotels = Array.isArray(data.hotels) ? data.hotels : [];

  console.log(`Quote: ${data.quoteId}`);
  console.log(`Plan: ${data.planId}`);
  console.log(`Hotel rows: ${hotels.length}`);
  console.log(`Supplier hotels: ${data.hotelAvailability?.supplierHotelCount ?? 0}`);
  console.log(`Placeholders: ${data.hotelAvailability?.placeholderRowCount ?? 0}`);
  console.log('');

  const grouped = new Map();
  for (const hotel of hotels) {
    const key = `${hotel.groupType}::${hotel.itineraryRouteId}::${hotel.destination}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(hotel);
  }

  const sortedKeys = Array.from(grouped.keys()).sort((a, b) => {
    const [ga, ra] = a.split('::').map((v, i) => (i < 2 ? Number(v) : v));
    const [gb, rb] = b.split('::').map((v, i) => (i < 2 ? Number(v) : v));
    return ga - gb || ra - rb;
  });

  for (const key of sortedKeys) {
    const [groupType, routeId, destination] = key.split('::');
    const rows = grouped.get(key);
    console.log(`Group ${groupType} | Route ${routeId} | ${destination}`);
    for (const row of rows.slice(0, 8)) {
      const price = Number(row.totalHotelCost || 0).toFixed(2);
      console.log(
        `  - ${row.hotelName} | provider=${row.provider} | meal=${row.mealPlan || '-'} | room=${row.roomType || '-'} | price=${price} | bookable=${row.isBookable}`,
      );
    }
    if (rows.length > 8) {
      console.log(`  ... ${rows.length - 8} more`);
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
