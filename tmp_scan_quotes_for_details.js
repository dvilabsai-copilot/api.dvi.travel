require('dotenv').config();
const mysql = require('mysql2/promise');

const BASE = 'http://127.0.0.1:4006/api/v1';

function valuesFromAnyShape(json) {
  if (Array.isArray(json?.result?.data)) return json.result.data;
  if (Array.isArray(json?.result)) return json.result;
  if (Array.isArray(json?.hotels)) return json.hotels;
  if (Array.isArray(json?.result?.hotels)) return json.result.hotels;
  return [];
}

function nonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  const s = String(v).trim();
  return s !== '' && s !== '[]' && s !== '{}' && s.toLowerCase() !== 'null';
}

function extract(h) {
  return {
    amenities: h.amenities,
    inclusions: h.inclusions,
    rateConditions: h.rateConditions ?? h.rate_conditions,
    supplementSummary: h.supplementSummary ?? h.supplement_summary,
    mandatorySupplements: h.mandatorySupplements ?? h.mandatory_supplements,
  };
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

  const [plans] = await c.query("SELECT itinerary_quote_ID FROM dvi_itinerary_plan_details WHERE deleted=0 AND status=1 ORDER BY itinerary_plan_ID DESC LIMIT 300");
  await c.end();

  const found = [];

  for (const p of plans) {
    const quoteId = p.itinerary_quote_ID;
    if (!quoteId) continue;
    try {
      const r = await fetch(`${BASE}/itineraries/hotel_details/${quoteId}?page=1&pageSize=600`);
      if (!r.ok) continue;
      const json = await r.json();
      const hotels = valuesFromAnyShape(json);
      if (!hotels.length) continue;

      const matches = hotels.filter((h) => {
        const e = extract(h);
        return nonEmpty(e.amenities) || nonEmpty(e.inclusions) || nonEmpty(e.rateConditions) || nonEmpty(e.supplementSummary) || nonEmpty(e.mandatorySupplements);
      });

      if (matches.length) {
        found.push({
          quoteId,
          totalHotels: hotels.length,
          matched: matches.length,
          sample: matches.slice(0, 3).map((h) => ({
            city: h.destination || h.city || h.hotelCity || h.hotel_city,
            hotelId: h.hotelId || h.hotel_id,
            hotelName: h.hotelName || h.hotel_name,
            itineraryRouteId: h.itineraryRouteId || h.itinerary_route_id,
            amenities: extract(h).amenities,
            inclusions: extract(h).inclusions,
            rateConditions: extract(h).rateConditions,
            supplementSummary: extract(h).supplementSummary,
            mandatorySupplements: extract(h).mandatorySupplements,
          })),
        });
      }
    } catch (e) {
    }
  }

  console.log(JSON.stringify({ checked: plans.length, foundCount: found.length, found: found.slice(0, 15) }, null, 2));
})();
