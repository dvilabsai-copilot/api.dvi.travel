const http = require('http');
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc2ODI2NTEsImV4cCI6MTc3ODI4NzQ1MX0.7pWoIL-8qRkUXDb24aLdCM0no5DVBrjTONv9LyMZjwU';

const req = http.request({
  host: 'localhost',
  port: 4006,
  path: '/api/v1/itineraries/hotspots/available/3108',
  method: 'GET',
  headers: { 'Authorization': 'Bearer ' + TOKEN }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(d);
      const list = parsed?.data || parsed;
      const arr = Array.isArray(list) ? list : (Array.isArray(list?.hotspots) ? list.hotspots : []);
      const hotspot12 = arr.find(h => h.id === 12);
      if (hotspot12) {
        console.log('Hotspot 12 timings:', hotspot12.timings);
        console.log('Full record:', JSON.stringify(hotspot12));
      } else {
        console.log('Hotspot 12 not found. First 3:', JSON.stringify(arr.slice(0,3)));
        console.log('Response keys:', Object.keys(parsed));
      }
    } catch (e) {
      console.log('Parse error, raw (500 chars):', d.substring(0, 500));
    }
  });
});
req.on('error', e => console.error(e.message));
req.end();
