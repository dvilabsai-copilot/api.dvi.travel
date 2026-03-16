const https = require('https');

const API_BASE_URL = process.env.PROD_API_BASE_URL || 'https://dvi.travel/api/v1';
const QUOTE_ID = process.env.QUOTE_ID || 'DVI2026012';
const TOKEN = process.env.PROD_JWT_TOKEN || '';

if (!TOKEN) {
  console.error('Missing PROD_JWT_TOKEN environment variable.');
  process.exit(1);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search || ''}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        let parsedBody;
        try {
          parsedBody = JSON.parse(body);
        } catch (err) {
          parsedBody = body;
        }
        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function main() {
  const detailsUrl = `${API_BASE_URL}/itineraries/details/${QUOTE_ID}`;
  const hotelDetailsUrl = `${API_BASE_URL}/itineraries/hotel_details/${QUOTE_ID}`;

  console.log(`\nFetching itinerary details for ${QUOTE_ID}`);
  console.log(`GET ${detailsUrl}\n`);
  const details = await getJson(detailsUrl);
  console.log(`details status: ${details.statusCode}`);
  console.log(JSON.stringify(details.body, null, 2));

  console.log(`\nFetching hotel details for ${QUOTE_ID}`);
  console.log(`GET ${hotelDetailsUrl}\n`);
  const hotels = await getJson(hotelDetailsUrl);
  console.log(`hotel_details status: ${hotels.statusCode}`);

  const hotelList = Array.isArray(hotels.body?.result) ? hotels.body.result : [];
  const hobseLike = hotelList.filter((h) => Number(h?.hotel_category) === 2);

  console.log(`Total hotels in response: ${hotelList.length}`);
  console.log(`Potential HOBSE hotels (hotel_category=2): ${hobseLike.length}`);

  if (hobseLike.length > 0) {
    console.log('\nSample potential HOBSE hotels:');
    hobseLike.slice(0, 5).forEach((h, i) => {
      console.log(`${i + 1}. ${h.hotel_name || 'N/A'} | city: ${h.hotel_city || 'N/A'} | code: ${h.hotel_code || 'N/A'}`);
    });
  }

  console.log('\nRaw hotel_details payload:');
  console.log(JSON.stringify(hotels.body, null, 2));
}

main().catch((err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});
