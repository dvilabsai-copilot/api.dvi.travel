require('dotenv').config();
const mysql = require('mysql2/promise');

const BASE = 'http://127.0.0.1:4006/api/v1';

function hasDetails(item) {
  const isNonEmpty = (v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    const s = String(v).trim();
    return s !== '' && s !== '[]' && s !== '{}' && s.toLowerCase() !== 'null';
  };

  return isNonEmpty(item.amenities)
    || isNonEmpty(item.inclusions)
    || isNonEmpty(item.rateConditions)
    || isNonEmpty(item.rate_conditions)
    || isNonEmpty(item.supplementSummary)
    || isNonEmpty(item.supplement_summary)
    || isNonEmpty(item.mandatorySupplements)
    || isNonEmpty(item.mandatory_supplements);
}

(async () => {
  const m = process.env.DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
  const c = await mysql.createConnection({
    host: m[3],
    port: Number(m[4]),
    user: decodeURIComponent(m[1]),
    password: decodeURIComponent(m[2]),
    database: m[5],
  });

  const [plans] = await c.query("SELECT itinerary_quote_ID FROM dvi_itinerary_plan_details WHERE deleted=0 AND status=1 ORDER BY itinerary_plan_ID DESC LIMIT 40");
  await c.end();

  const out = [];

  for (const p of plans) {
    const quoteId = p.itinerary_quote_ID;
    if (!quoteId) continue;
    try {
      const res = await fetch(`${BASE}/itineraries/hotel_room_details/${quoteId}`);
      const json = await res.json();
      const rows = Array.isArray(json?.result) ? json.result : [];
      const matches = rows.filter(hasDetails);
      if (matches.length > 0) {
        out.push({
          quoteId,
          totalRows: rows.length,
          matchedRows: matches.length,
          sample: matches.slice(0, 5).map((x) => ({
            routeId: x.routeId || x.itinerary_route_id || x.itineraryRouteId,
            city: x.city || x.hotelCity || x.hotel_city || x.location,
            hotelId: x.hotelId || x.hotel_id,
            hotelName: x.hotelName || x.hotel_name,
            hasAmenities: !!x.amenities,
            hasInclusions: !!x.inclusions,
            hasRateConditions: !!(x.rateConditions || x.rate_conditions),
            hasSupplements: !!(x.supplementSummary || x.supplement_summary || x.mandatorySupplements || x.mandatory_supplements),
          })),
        });
      }
    } catch (e) {
      // ignore per quote
    }
  }

  console.log(JSON.stringify(out.slice(0, 10), null, 2));
})();
