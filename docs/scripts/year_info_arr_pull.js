const https = require('https');
const fs = require('fs');

const payload = JSON.stringify({
  propertyid: 'STAAHTESTHOTEL1',
  apikey: 'Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH',
  room_id: 'DELUXEROOM',
  rate_id: 'CPPLAN',
  action: 'year_info_ARR',
  version: '2',
});

const req = https.request(
  {
    hostname: 'channelconnect.otaswitch.com',
    path: '/common-cgi/dviholidays/test/services.pl',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      fs.writeFileSync('arr_full_year_latest.json', body, 'utf8');
      console.log('STATUS:', res.statusCode, 'BYTES:', body.length);
      try {
        const json = JSON.parse(body);
        console.log('HAS_DATA:', Array.isArray(json.data));
        console.log('ROWS:', Array.isArray(json.data) ? json.data.length : 0);
        console.log('ERROR:', json.error_desc || '');
      } catch {
        console.log('JSON_PARSE_ERR');
      }
    });
  },
);

req.on('error', (err) => {
  console.error(err.message);
  process.exit(1);
});

req.write(payload);
req.end();
