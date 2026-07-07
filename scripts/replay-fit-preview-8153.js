const http = require('http');

const payload = {
  routeId: 8153,
  selectedHotspotId: 898,
  anchor: {
    anchorType: 'BETWEEN_ROWS',
    anchorIntent: 'AFTER_ATTRACTION',
    anchorIndex: 4,
    anchorFrom: 'Oottupura Restaurant',
    anchorTo: 'Clay Oven Resturant',
    anchorLabel: 'After Oottupura Restaurant',
    anchorTimeRange: '12:00 PM - 12:45 PM',
    afterRowType: 'attraction',
    beforeRowType: 'hotspot',
    afterHotspotId: 899,
    afterRouteHotspotId: 128365,
    beforeHotspotId: 596,
    beforeRouteHotspotId: 128372,
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};

const req = http.request({
  hostname: '127.0.0.1',
  port: 4006,
  path: '/api/v1/itineraries/9825/manual-hotspot/fit-preview',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4'
  }
}, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log(body);
  });
});
req.on('error', (err) => {
  console.error('REQ_ERR', err && err.stack || String(err));
  process.exit(1);
});
req.write(JSON.stringify(payload));
req.end();

