const auth = 'Basic ' + Buffer.from('Doview:Doview@12345').toString('base64');

async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

(async () => {
  const country = await api('http://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList');
  console.log(JSON.stringify({ status: country.status, keys: Object.keys(country.json || {}), sample: country.json?.CountryList?.slice?.(0,2) || null }, null, 2));
})();
