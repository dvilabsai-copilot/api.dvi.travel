const quoteId = process.argv[2] || 'DVI20260320';
const base = process.argv[3] || 'http://127.0.0.1:4006/api/v1';

async function main() {
  await fetch(`${base}/itineraries/hotel_details/${quoteId}/rebuild`, { method: 'POST' }).catch(() => null);
  const res = await fetch(`${base}/itineraries/hotel_details/${quoteId}?page=1&pageSize=200`);
  const body = await res.json();

  const rows = Array.isArray(body?.hotels) ? body.hotels : [];
  const byRoute = new Map();

  for (const r of rows) {
    const routeId = Number(r.itineraryRouteId || 0);
    const key = String(r.provider || 'unknown').toLowerCase();
    if (!byRoute.has(routeId)) byRoute.set(routeId, { total: 0, providers: {} });
    const obj = byRoute.get(routeId);
    obj.total++;
    obj.providers[key] = (obj.providers[key] || 0) + 1;
  }

  console.log('status:', res.status);
  console.log('total rows:', rows.length);
  console.log('byRoute:', JSON.stringify(Object.fromEntries(byRoute), null, 2));

  const sample = rows.slice(0, 20).map((r) => ({
    routeId: r.itineraryRouteId,
    day: r.dayNo,
    destination: r.destination,
    hotel: r.hotelName,
    provider: r.provider,
  }));
  console.log('sample rows:', JSON.stringify(sample, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
