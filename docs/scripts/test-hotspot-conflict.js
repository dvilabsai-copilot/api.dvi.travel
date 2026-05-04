const http = require('http');
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';

const body = JSON.stringify({
  routeId: 3108,
  hotspotId: 12,
  anchorType: 'after_travel',
  anchorIndex: 0,
  allowTopPriorityRemoval: false,
  selectedHotspotIds: [12]
});

const req = http.request({
  host: 'localhost',
  port: 4006,
  path: '/api/v1/itineraries/292/manual-hotspot/preview',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Authorization': 'Bearer ' + TOKEN
  }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(d);
      console.log('HTTP status:', res.statusCode);
      // Try to find newHotspot in various response shapes
      const nh = parsed?.data?.newHotspot || parsed?.newHotspot || (parsed?.data && Object.keys(parsed.data).length < 5 ? parsed.data : null);
      if (nh) {
        console.log('isConflict:', nh.isConflict);
        console.log('conflictReason:', nh.conflictReason);
        console.log('startTime:', nh.hotspot_start_time || nh.startTime);
        console.log('endTime:', nh.hotspot_end_time || nh.endTime);
      } else {
        console.log('Response keys:', Object.keys(parsed));
        if (parsed.data) console.log('data keys:', Object.keys(parsed.data));
        console.log(JSON.stringify(parsed).substring(0, 800));
      }
    } catch (e) {
      console.log('Raw response (first 800):', d.substring(0, 800));
    }
  });
});
req.on('error', e => console.error(e.message));
req.write(body);
req.end();
