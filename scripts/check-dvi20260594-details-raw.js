const http = require('http');
const API_BASE = 'http://127.0.0.1:4006/api/v1';
const QUOTE_ID = process.env.QUOTE_ID || 'DVI20260594';
const token = process.env.DVI_JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODAxNTUzNDQsImV4cCI6MTc4MDc2MDE0NH0.3qZPh6VNDxZvrpWTTZA3BliZKyGEGhuNgNuIAfWudu0';
const url = new URL(`${API_BASE}/itineraries/details/${QUOTE_ID}`);

http.request({ hostname:url.hostname, port:url.port || 80, path:url.pathname, method:'GET', headers:{ Authorization:`Bearer ${token}` } }, (res) => {
  let data='';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log('status', res.statusCode);
    const j = JSON.parse(data);
    console.log('topKeys', Object.keys(j));
    console.log('vehicleBuildStatus', j.vehicleBuildStatus || j?.data?.vehicleBuildStatus || null);
    const days = Array.isArray(j.days) ? j.days : (Array.isArray(j?.data?.days) ? j.data.days : []);
    console.log('daysCount', days.length);
    days.forEach((d, i) => console.log('dayKeys', i + 1, Object.keys(d || {})));
    const day2 = days.find(d => Number(d?.dayNumber || 0) === 2) || days[1];
    console.log('day2Full', JSON.stringify(day2, null, 2));
    const segs = Array.isArray(day2?.segments) ? day2.segments : [];
    segs.forEach((s, i) => {
      console.log('segment', i, Object.keys(s || {}));
      console.log('segmentFields', i, {
        title: s?.title,
        name: s?.name,
        hotspot_name: s?.hotspot_name,
        hotspotName: s?.hotspotName,
        segmentTitle: s?.segmentTitle,
        display_name: s?.display_name,
        label: s?.label,
        item_type: s?.item_type,
        hotspot_ID: s?.hotspot_ID,
        placeName: s?.placeName,
        nested_hotspot_name: s?.hotspot?.hotspot_name,
        nested_hotspot_name2: s?.hotspot?.name,
      });
    });
  });
}).end();
