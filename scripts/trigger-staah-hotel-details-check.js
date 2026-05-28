const axios = require('axios');

(async () => {
  const quoteId = process.argv[2] || 'DVI20260589';
  const baseUrl = process.env.API_BASE_URL || 'http://127.0.0.1:4006';
  const token = process.env.API_BEARER_TOKEN || process.argv[3] || '';

  if (!token) {
    console.error('Missing bearer token. Set API_BEARER_TOKEN or pass as 2nd arg.');
    process.exit(1);
  }

  const url = `${baseUrl}/api/v1/itineraries/hotel_details/${quoteId}`;
  console.log('Calling:', url);

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: '*/*',
    },
    timeout: 60000,
  });

  console.log('HTTP Status:', res.status);

  const payload = res.data || {};
  const rows = payload?.data?.hotel_rows || payload?.hotel_rows || [];
  console.log('Total hotel rows:', rows.length);

  const byRoute = new Map();
  for (const row of rows) {
    const routeId = Number(row.itinerary_route_ID || row.routeId || row.itineraryRouteId || 0);
    if (!byRoute.has(routeId)) byRoute.set(routeId, []);
    byRoute.get(routeId).push(row);
  }

  console.log('Route count:', byRoute.size);
  for (const [routeId, list] of byRoute.entries()) {
    console.log(`Route ${routeId}: ${list.length} hotels`);
    for (const h of list) {
      console.log(`  - provider=${String(h.provider || '').toLowerCase()} hotelCode=${h.hotelCode} hotelName=${h.hotelName} price=${h.price} mealPlan=${h.mealPlan || '-'}`);
    }
  }

  const staahHotels = rows.filter((h) => String(h.provider || '').toLowerCase() === 'staah');
  console.log('STAAH hotels found:', staahHotels.length);

  const staah44674 = staahHotels.find((h) => String(h.hotelCode) === '44674');
  if (staah44674) {
    console.log('STAAH 44674 present: YES');
    console.log({
      provider: staah44674.provider,
      hotelCode: staah44674.hotelCode,
      hotelName: staah44674.hotelName,
      price: staah44674.price,
      mealPlan: staah44674.mealPlan,
      routeId: staah44674.itinerary_route_ID || staah44674.routeId || null,
    });
  } else {
    console.log('STAAH 44674 present: NO');
  }
})().catch((err) => {
  if (err.response) {
    console.error('Request failed:', err.response.status, err.response.statusText);
    console.error('Body:', JSON.stringify(err.response.data, null, 2));
  } else {
    console.error('Error:', err.message);
  }
  process.exit(1);
});
