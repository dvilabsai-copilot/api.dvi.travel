const https = require('https');

const actions = ['property_info', 'roomrate_info', 'mapping'];

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'channelconnect.otaswitch.com',
        path: '/common-cgi/dviholidays/test/services.pl',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const action of actions) {
    const payload = {
      propertyid: 'STAAHTESTHOTEL1',
      apikey: 'Le4-E6F-1F2RB-xZ8a-Oms-jrXIQ-7w73FIH',
      action,
      version: '2',
    };
    const res = await post(payload);
    console.log('\nACTION:', action, 'HTTP:', res.status);
    console.log(res.body);
  }
})();
