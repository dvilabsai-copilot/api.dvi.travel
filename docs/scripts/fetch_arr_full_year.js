const https = require('https');
const today = new Date();
const from = today.toISOString().split('T')[0];
const end = new Date(today.getTime() + 364 * 24 * 60 * 60 * 1000);
const to = end.toISOString().split('T')[0];
const payload = JSON.stringify({
  action: 'ARR_info',
  propertyid: 'STAAHTESTHOTEL1',
  apikey: 'Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH',
  room_id: 'DELUXE',
  rate_id: 'CP',
  from_date: from,
  to_date: to,
  version: '2'
});
console.log('Fetching ARR from', from, 'to', to);
const options = {
  hostname: 'channelconnect.otaswitch.com',
  path: '/common-cgi/dviholidays/test/services.pl',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
};
const req = https.request(options, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    require('fs').writeFileSync('arr_full_year_latest.json', d);
    console.log('STATUS:', res.statusCode, 'BYTES:', d.length);
    try {
      const parsed = JSON.parse(d);
      if (parsed.data) console.log('ROWS:', parsed.data.length);
    } catch(e) {}
  });
});
req.on('error', e => console.error(e));
req.write(payload);
req.end();
