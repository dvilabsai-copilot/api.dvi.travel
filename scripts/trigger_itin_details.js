const http = require('http');

const API_BASE_URL = 'http://127.0.0.1:4006/api/v1';
const token = process.env.DVI_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODAxNTUzNDQsImV4cCI6MTc4MDc2MDE0NH0.3qZPh6VNDxZvrpWTTZA3BliZKyGEGhuNgNuIAfWudu0';

const quoteId = String(process.argv[2] || '').trim();
if (!quoteId) {
  console.error('Usage: node scripts/trigger_itin_details.js <QUOTE_ID>');
  process.exit(1);
}

const url = new URL(`${API_BASE_URL}/itineraries/details/${encodeURIComponent(quoteId)}`);
const options = {
  hostname: url.hostname,
  port: Number(url.port || 80),
  path: `${url.pathname}${url.search || ''}`,
  method: 'GET',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: '*/*',
    'Cache-Control': 'no-cache',
  },
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    try {
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    } catch {
      console.log(data);
    }

    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      process.exit(0);
    }
    process.exit(1);
  });
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});

req.end();
