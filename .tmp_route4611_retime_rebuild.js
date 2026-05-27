const http = require('http');

const token = process.env.PROD_JWT_TOKEN || '';
if (!token) {
  console.error('Missing PROD_JWT_TOKEN');
  process.exit(1);
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 4006,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed = out;
          try { parsed = JSON.parse(out); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const patch = await request('PATCH', '/api/v1/itineraries/385/route/4611/times', {
    startTime: '08:00:00',
    endTime: '20:00:00',
    previousDayBillingDecisionProvided: true,
    previousDayBillingConfirmed: false,
  });
  console.log('PATCH', patch.status, patch.body);

  const rebuild = await request('POST', '/api/v1/itineraries/385/route/4611/rebuild', {});
  console.log('REBUILD', rebuild.status, rebuild.body);
})();
