const http = require('http');
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';

async function testRoute(routeId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      routeId,
      hotspotId: 12,
      anchorType: 'after_travel',
      anchorIndex: 0,
      allowTopPriorityRemoval: false,
      selectedHotspotIds: [12]
    });
    const req = http.request({
      host: 'localhost', port: 4006,
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
          // Drill into response
          const nh = parsed?.data?.newHotspot || parsed?.newHotspot;
          if (nh) {
            console.log(`Route ${routeId} -> isConflict: ${nh.isConflict} | reason: ${nh.conflictReason || '(none)'} | start: ${nh.hotspot_start_time}`);
          } else {
            // Try to find newHotspot deeper
            const dataStr = JSON.stringify(parsed);
            const match = dataStr.match(/"isConflict":(\w+)/);
            const reasonMatch = dataStr.match(/"conflictReason":"([^"]+)"/);
            console.log(`Route ${routeId} -> isConflict: ${match?.[1]} | reason: ${reasonMatch?.[1] || '(none)'}`);
            if (!match) console.log('  Response snippet:', dataStr.substring(0, 400));
          }
        } catch (e) {
          console.log(`Route ${routeId} parse error:`, d.substring(0, 300));
        }
        resolve();
      });
    });
    req.on('error', e => { console.error('Route ' + routeId + ' error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const routeId of [3108, 3109, 3110]) {
    await testRoute(routeId);
  }
})();
