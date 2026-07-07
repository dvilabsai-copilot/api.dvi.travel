const http = require('http');
const payload = {
  routeId: 8175,
  selectedHotspotId: 41,
  anchor: {
    anchorType: 'BETWEEN_ROWS',
    anchorIntent: 'AFTER_ATTRACTION',
    anchorIndex: 6,
    anchorFrom: 'Pamban Bridge',
    anchorTo: 'Travel to Hotel',
    anchorLabel: 'After Pamban Bridge',
    anchorTimeRange: '05:15 PM - 05:30 PM',
    afterRowType: 'attraction',
    beforeRowType: 'travel',
    afterHotspotId: 40,
    afterRouteHotspotId: 147208,
    beforeHotspotId: null,
    beforeRouteHotspotId: null,
  },
  allowP3Removal: true,
  allowP1P2Removal: true,
};
function toRows(arr) {
  return (arr || []).map((row, index) => ({
    index,
    type: row.type || row.item_type,
    name: row.name || row.text || null,
    hotspotId: Number(row.hotspotId || row.hotspot_ID || row.locationId || row.hotspot_id || 0) || null,
    timeRange: row.timeRange || null,
  }));
}
const req = http.request({ hostname:'127.0.0.1', port:4006, path:'/api/v1/itineraries/9823/manual-hotspot/fit-preview', method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODMxOTQxNzMsImV4cCI6MTc4Mzc5ODk3M30.YKoeQHCI9qIpV33Nn27pqP_ArqtuNkXanrhzHhxyPg4'}} , res => {
 let body=''; res.on('data',c=>body+=c); res.on('end',()=>{ const json=JSON.parse(body); console.log(JSON.stringify({ routeTimeline: toRows(json.routeTimeline || json.fullTimeline), proposedTimeline: toRows(json.proposedTimeline), finalizedTimeline: toRows(json.finalizedTimeline) }, null, 2));});
});
req.on('error', e=>{console.error(e.stack||String(e)); process.exit(1);});
req.write(JSON.stringify(payload)); req.end();
