const https = require('https');
const fs = require('fs');

const PROPERTY_ID = 'STAAHTESTHOTEL1';
const API_KEY = 'Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH';
const ROOM_ID = 'DELUXEROOM';
const RATE_ID = 'CPPLAN';
const FETCH_URL = 'https://channelconnect.otaswitch.com/common-cgi/dviholidays/test/services.pl';

function postJson(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: new URL(FETCH_URL).hostname,
        path: new URL(FETCH_URL).pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const tests = [
    {
      row: 4,
      label: 'property_info',
      request: { propertyid: PROPERTY_ID, apikey: API_KEY, action: 'property_info', version: '2' },
    },
    {
      row: 5,
      label: 'roomrate_info',
      request: { propertyid: PROPERTY_ID, apikey: API_KEY, action: 'roomrate_info', version: '2' },
    },
    {
      row: 6,
      label: 'arr_single_date',
      request: {
        propertyid: PROPERTY_ID,
        apikey: API_KEY,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        action: 'ARR_info',
        from_date: '2026-07-20',
        to_date: '2026-07-20',
        version: '2',
      },
    },
    {
      row: 7,
      label: 'arr_28_days',
      request: {
        propertyid: PROPERTY_ID,
        apikey: API_KEY,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        action: 'ARR_info',
        from_date: '2026-12-15',
        to_date: '2027-01-11',
        version: '2',
      },
    },
    {
      row: 8,
      label: 'arr_first_10_days',
      request: {
        propertyid: PROPERTY_ID,
        apikey: API_KEY,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        action: 'ARR_info',
        from_date: '2026-06-01',
        to_date: '2026-06-10',
        version: '2',
      },
    },
    {
      row: 9,
      label: 'year_info_ARR',
      request: {
        propertyid: PROPERTY_ID,
        apikey: API_KEY,
        room_id: ROOM_ID,
        rate_id: RATE_ID,
        action: 'year_info_ARR',
        version: '2',
      },
    },
  ];

  const results = [];
  for (const test of tests) {
    const response = await postJson(test.request);
    results.push({
      row: test.row,
      label: test.label,
      requestedAt: new Date().toISOString(),
      request: test.request,
      response,
    });
    console.log(test.label, response.status);
  }

  fs.writeFileSync('ari_latest_summary.json', JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  const yearInfo = results.find((r) => r.label === 'year_info_ARR');
  if (yearInfo) {
    fs.writeFileSync('arr_full_year_latest.json', JSON.stringify(yearInfo.response.body, null, 2));
  }
})();
