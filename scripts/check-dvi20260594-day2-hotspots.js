const http = require('http');

const API_BASE_URL = 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = 'DVI20260594';
const REQUIRED = ['Cheeyappara Waterfalls'];
const FORBIDDEN = ['St. Francis Church', 'Paradesi Synagogue', 'Santa Cruz Basilica', 'Valara Water Falls'];
const token = process.env.DVI_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODAxNTUzNDQsImV4cCI6MTc4MDc2MDE0NH0.3qZPh6VNDxZvrpWTTZA3BliZKyGEGhuNgNuIAfWudu0';

const url = new URL(`${API_BASE_URL}/itineraries/details/${QUOTE_ID}`);
const options = {
  hostname: url.hostname,
  port: url.port || 80,
  path: `${url.pathname}${url.search || ''}`,
  method: 'GET',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: '*/*',
  },
};

function pickDays(payload) {
  if (Array.isArray(payload?.days)) return payload.days;
  if (Array.isArray(payload?.data?.days)) return payload.data.days;
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchOnce = () => new Promise((resolve, reject) => {
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}: ${data}`));
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); }
    });
  });
  req.on('error', reject);
  req.end();
});

(async () => {
  let parsed = null;
  let day2Hotspots = [];
  for (let attempt = 1; attempt <= 18; attempt++) {
    parsed = await fetchOnce();
    const days = pickDays(parsed);
    const day2Route = days.find((d) => Number(d?.dayNumber || 0) === 2) || days[1];
    day2Hotspots = (Array.isArray(day2Route?.segments) ? day2Route.segments : [])
      .filter((s) => {
        const type = String(s?.type || '').toLowerCase();
        const hotspotId = Number(s?.hotspotId || s?.hotspot_ID || s?.hotspot?.hotspot_ID || 0);
        return type === 'attraction' || hotspotId > 0;
      })
      .map((s) => String(
        s?.name ||
        s?.title ||
        s?.text ||
        s?.hotspot_name ||
        s?.hotspotName ||
        s?.placeName ||
        s?.hotspot?.hotspot_name ||
        s?.hotspot?.name ||
        ''
      ).trim())
      .filter((name) => name && name.toLowerCase() !== 'click to add hotspot');
    const vehicleBuildStatus = String(parsed?.vehicleBuildStatus || parsed?.data?.vehicleBuildStatus || '').toUpperCase();
    console.log(`Attempt ${attempt}: vehicleBuildStatus=${vehicleBuildStatus || 'N/A'} day2Hotspots=${JSON.stringify(day2Hotspots)}`);
    if (day2Hotspots.length > 0 && vehicleBuildStatus !== 'PROCESSING') break;
    if (attempt < 18) await sleep(10000);
  }
  const requiredMissing = REQUIRED.filter((n) => !day2Hotspots.includes(n));
  const forbiddenPresent = FORBIDDEN.filter((n) => day2Hotspots.includes(n));
  console.log('requiredPresent:', REQUIRED.filter((n) => day2Hotspots.includes(n)));
  console.log('requiredMissing:', requiredMissing);
  console.log('forbiddenPresent:', forbiddenPresent);
  console.log('forbiddenMissing:', FORBIDDEN.filter((n) => !day2Hotspots.includes(n)));
  if (requiredMissing.length > 0 || forbiddenPresent.length > 0) process.exit(2);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
