const quoteId = 'DVI202604246';
const BASE = 'http://127.0.0.1:4006/api/v1';

function walk(obj, path = '', out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (/amen|inclu|rate.?condition|supple/i.test(k)) {
        out.push({ keyPath: p, valueType: Array.isArray(v) ? 'array' : typeof v, preview: typeof v === 'string' ? v.slice(0,120) : (Array.isArray(v) ? `len=${v.length}` : JSON.stringify(v).slice(0,120)) });
      }
      walk(v, p, out);
    }
  }
  return out;
}

(async () => {
  const res = await fetch(`${BASE}/itineraries/hotel_details/${quoteId}?page=1&pageSize=20`);
  const json = await res.json();
  const rows = Array.isArray(json?.result?.data) ? json.result.data : [];
  const first = rows[0] || {};
  const hits = walk(first);
  console.log(JSON.stringify({ quoteId, rowCount: rows.length, hits: hits.slice(0, 120) }, null, 2));
})();
