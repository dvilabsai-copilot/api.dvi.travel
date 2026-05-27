const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'localhost',
    user: 'dvi_user',
    password: 'myDvi123!',
    database: 'dvi_main',
  });

  const [route] = await c.execute(
    'SELECT itinerary_route_date FROM dvi_itinerary_route_details WHERE itinerary_route_ID=?',
    [4611],
  );
  const routeDate = new Date(route[0].itinerary_route_date);
  const jsDay = routeDate.getUTCDay();
  const phpDow = jsDay === 0 ? 6 : jsDay - 1; // PHP date('N')-1
  console.log('routeDate', routeDate.toISOString(), 'jsDay', jsDay, 'phpDow', phpDow);

  const [mysoreHotspots] = await c.execute(
    "SELECT hotspot_ID,hotspot_name FROM dvi_hotspot_place WHERE deleted=0 AND status=1 AND hotspot_location LIKE '%Mysore%'",
  );
  const ids = mysoreHotspots.map((r) => r.hotspot_ID);

  const [timings] = await c.execute(
    `SELECT hotspot_ID,hotspot_timing_day,hotspot_start_time,hotspot_end_time,deleted,status
     FROM dvi_hotspot_timing
     WHERE hotspot_ID IN (${ids.map(() => '?').join(',')})
     ORDER BY hotspot_ID,hotspot_timing_day`,
    ids,
  );

  const byHotspot = new Map();
  for (const t of timings) {
    if (!byHotspot.has(t.hotspot_ID)) byHotspot.set(t.hotspot_ID, []);
    byHotspot.get(t.hotspot_ID).push(t);
  }

  for (const hs of mysoreHotspots) {
    const arr = byHotspot.get(hs.hotspot_ID) || [];
    const active = arr.filter((x) => Number(x.deleted) === 0 && Number(x.status) === 1);
    const today = active.filter((x) => Number(x.hotspot_timing_day) === phpDow);
    console.log(hs.hotspot_ID, hs.hotspot_name, 'activeRows=', active.length, 'todayRows=', today.length);
  }

  await c.end();
})();
