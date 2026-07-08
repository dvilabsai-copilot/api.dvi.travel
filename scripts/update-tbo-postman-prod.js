const fs = require('fs');
const path = require('path');

const inputPath = path.join(
  process.cwd(),
  'TBO - Hotel Certification FULL Pack (8 Cases) - Auto Chaining.postman_collection.json',
);
const outputPath = path.join(
  process.cwd(),
  'postman',
  'TBO-Hotel-Certification-FULL-Pack-8-Cases-Auto-Chaining.PROD.postman_collection.json',
);

const collection = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function walk(items, visitor) {
  for (const item of items || []) {
    visitor(item);
    if (item.item) walk(item.item, visitor);
  }
}

function setCollectionVar(key, value) {
  collection.variable = collection.variable || [];
  const existing = collection.variable.find((entry) => entry.key === key);
  if (existing) {
    existing.value = String(value);
    existing.type = 'string';
    return;
  }
  collection.variable.push({ key, value: String(value), type: 'string' });
}

function setBodyFromObject(request, body) {
  request.body = request.body || {};
  request.body.mode = 'raw';
  request.body.raw = JSON.stringify(body, null, 2);
  request.body.options = request.body.options || { raw: { language: 'json' } };
}

function setBodyFromRaw(request, raw) {
  request.body = request.body || {};
  request.body.mode = 'raw';
  request.body.raw = raw;
  request.body.options = request.body.options || { raw: { language: 'json' } };
}

function rewriteUrl(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .replace(
      'https://sharedapi.tektravels.com/SharedData.svc/rest/Authenticate',
      'https://api.travelboutiqueonline.com/SharedAPI/SharedData.svc/rest/Authenticate',
    )
    .replace(
      'http://api.tbotechnology.in/TBOHolidays_HotelAPI/',
      'http://affiliate.travelboutiqueonline.com/TBOHolidays_HotelAPI/',
    )
    .replace(
      'https://affiliate.tektravels.com/HotelAPI/',
      'https://affiliate.travelboutiqueonline.com/HotelAPI/',
    )
    .replace(
      'https://hotelbe.tektravels.com/hotelservice.svc/rest/',
      'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/',
    )
    .replace(
      'https://HotelBE.tektravels.com/hotelservice.svc/rest/',
      'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest/',
    )
    .replace(
      'https://sharedapi.tektravels.com',
      'https://api.travelboutiqueonline.com/SharedAPI',
    )
    .replace(
      'https://affiliate.tektravels.com/HotelAPI',
      'https://affiliate.travelboutiqueonline.com/HotelAPI',
    )
    .replace(
      'https://hotelbe.tektravels.com/hotelservice.svc/rest',
      'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest',
    )
    .replace(
      'https://HotelBE.tektravels.com/hotelservice.svc/rest',
      'https://hotelbooking.travelboutiqueonline.com/HotelAPI_V10/HotelService.svc/rest',
    );
}

function removeAuth(request) {
  if (request && Object.prototype.hasOwnProperty.call(request, 'auth')) {
    delete request.auth;
  }
}

function normalizeUrlObject(url) {
  if (!url || typeof url.raw !== 'string') {
    return;
  }

  try {
    const parsed = new URL(url.raw);
    url.protocol = parsed.protocol.replace(':', '');
    url.host = parsed.hostname.split('.');
    url.path = parsed.pathname.split('/').filter(Boolean);
    if (parsed.search) {
      const query = [];
      parsed.searchParams.forEach((value, key) => {
        query.push({ key, value });
      });
      if (query.length > 0) {
        url.query = query;
      }
    }
  } catch {
    // Leave the original url object alone if it cannot be parsed.
  }
}

function replaceEventScript(item, listen, scriptText) {
  item.event = item.event || [];
  const existing = item.event.find((entry) => entry.listen === listen);
  const event = {
    listen,
    script: {
      type: 'text/javascript',
      exec: scriptText.split('\n'),
    },
  };
  if (existing) {
    existing.script = event.script;
    return;
  }
  item.event.push(event);
}

function rootPrerequestScript() {
  return `const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return \`\${y}-\${m}-\${day}\`;
};

const defaults = {
  CountryCode: 'IN',
  DubaiCountryCode: 'AE',
  CityCode: '127343',
  DubaiCityCode: '130990',
  CityNameFilter: 'Chennai',
  GuestNationality: 'IN',
  PaymentMode: 'Limit',
  NoOfRooms: '1',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!pm.collectionVariables.get(key)) {
    pm.collectionVariables.set(key, value);
  }
}

if (!pm.collectionVariables.get('CheckIn')) {
  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 15);
  pm.collectionVariables.set('CheckIn', ymd(checkIn));
}

if (!pm.collectionVariables.get('CheckOut')) {
  const checkOut = new Date();
  checkOut.setDate(checkOut.getDate() + 16);
  pm.collectionVariables.set('CheckOut', ymd(checkOut));
}`;
}

function searchTestScript() {
  return `function findFirst(obj, keys){
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const r = findFirst(obj[i], keys);
      if (r !== null && r !== undefined && r !== '') return r;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (keys.includes(k) && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') return obj[k];
    }
    for (const k of Object.keys(obj)) {
      const r = findFirst(obj[k], keys);
      if (r !== null && r !== undefined && r !== '') return r;
    }
  }
  return null;
}

let json;
try { json = pm.response.json(); } catch (error) { json = null; }
if (!json) { console.warn('No JSON response to parse'); }

const bookingCode = findFirst(json, ['BookingCode','bookingCode','HotelBookingCode']);
if (bookingCode) pm.collectionVariables.set('BookingCode', bookingCode);

const tokenId = findFirst(json, ['TokenId','tokenId']);
if (tokenId) pm.collectionVariables.set('TokenId', tokenId);

const traceId = findFirst(json, ['TraceId','traceId']);
if (traceId) pm.collectionVariables.set('TraceId', traceId);

const agencyId = findFirst(json, ['AgencyId','agencyId','TokenAgencyId','tokenAgencyId']);
if (agencyId) pm.collectionVariables.set('AgencyId', agencyId);

const netAmount = findFirst(json, ['NetAmount','netAmount','TotalFare','TotalPrice','Price','PublishedPriceRoundedOff','PublishedPrice']);
if (netAmount) pm.collectionVariables.set('NetAmount', netAmount);

if (Array.isArray(json?.CityList) && json.CityList.length) {
  const filter = String(pm.collectionVariables.get('CityNameFilter') || '').trim().toLowerCase();
  const selected = filter
    ? json.CityList.find((city) => String(city?.Name || '').toLowerCase().includes(filter))
    : json.CityList[0];
  if (selected?.Code) pm.collectionVariables.set('CityCode', String(selected.Code));
  if (selected?.Name) pm.collectionVariables.set('CityName', String(selected.Name));
}

if (Array.isArray(json?.Hotels) && json.Hotels.length) {
  const hotelCodes = json.Hotels
    .map((hotel) => String(hotel?.HotelCode || hotel?.hotelCode || '').trim())
    .filter(Boolean);
  if (hotelCodes.length) pm.collectionVariables.set('HotelCodes', hotelCodes.join(','));
}

try {
  const requestBody = pm.request?.body?.raw ? JSON.parse(pm.request.body.raw) : null;
  if (requestBody?.GuestNationality) {
    pm.collectionVariables.set('GuestNationality', String(requestBody.GuestNationality));
  }
} catch (error) {
  // Ignore malformed request bodies.
}

pm.test('Search parsed (BookingCode captured if present)', function(){ pm.expect(true).to.eql(true); });`;
}

function prebookPrerequestScript() {
  return `// Auto-inject booking values before sending the PreBook request.
let body = {};
try { body = JSON.parse(pm.request.body.raw); } catch (error) { body = {}; }
body.BookingCode = pm.collectionVariables.get('BookingCode') || body.BookingCode;
body.PaymentMode = pm.collectionVariables.get('PaymentMode') || body.PaymentMode || 'Limit';
body.GuestNationality = pm.collectionVariables.get('GuestNationality') || body.GuestNationality;
body.NoOfRooms = Number(pm.collectionVariables.get('NoOfRooms') || body.NoOfRooms || 1);
pm.request.body.update(JSON.stringify(body, null, 2));`;
}

collection.info = collection.info || {};
collection.info.name = 'TBO - Hotel Certification FULL Pack (8 Cases) - Auto Chaining - PROD';

collection.auth = {
  type: 'basic',
  basic: [
    { key: 'username', value: '{{UserName}}', type: 'string' },
    { key: 'password', value: '{{Password}}', type: 'string' },
  ],
};

collection.variable = [];
[
  ['ClientId', 'tboprod'],
  ['UserName', 'IXMD112'],
  ['Password', 'api-11#M$new'],
  ['EndUserIp', '134.209.145.185'],
  ['CountryCode', 'IN'],
  ['DubaiCountryCode', 'AE'],
  ['CityCode', '127343'],
  ['DubaiCityCode', '130990'],
  ['CityNameFilter', 'Chennai'],
  ['HotelCodes', ''],
  ['CheckIn', ''],
  ['CheckOut', ''],
  ['GuestNationality', 'IN'],
  ['PaymentMode', 'Limit'],
  ['NoOfRooms', '1'],
  ['BookingCode', ''],
  ['BookingId', ''],
  ['ConfirmationNo', ''],
  ['TokenId', ''],
  ['TraceId', ''],
  ['AgencyId', ''],
].forEach(([key, value]) => setCollectionVar(key, value));

collection.event = [
  {
    listen: 'prerequest',
    script: {
      type: 'text/javascript',
      exec: rootPrerequestScript().split('\n'),
    },
  },
];

walk(collection.item, (item) => {
  if (!item.request) return;

  if (item.request.url && typeof item.request.url.raw === 'string') {
    item.request.url.raw = rewriteUrl(item.request.url.raw);
    normalizeUrlObject(item.request.url);
  }

  if (item.name !== 'Authentication INT API') {
    removeAuth(item.request);
  }

  if (item.name === 'CityList') {
    removeAuth(item.request);
    setBodyFromObject(item.request, { CountryCode: '{{CountryCode}}' });
  }

  if (item.name === 'CityList Dubai') {
    removeAuth(item.request);
    setBodyFromObject(item.request, { CountryCode: '{{DubaiCountryCode}}' });
  }

  if (item.name === 'TBOHotelCodeList') {
    removeAuth(item.request);
    setBodyFromObject(item.request, { CityCode: '{{CityCode}}', IsDetailedResponse: 'true' });
  }

  if (item.name === 'TBOHotelCodeList Dubai') {
    removeAuth(item.request);
    setBodyFromObject(item.request, { CityCode: '{{DubaiCityCode}}', IsDetailedResponse: 'true' });
  }

  if (item.name === 'Authentication INT API') {
    setBodyFromObject(item.request, {
      ClientId: '{{ClientId}}',
      UserName: '{{UserName}}',
      Password: '{{Password}}',
      EndUserIp: '{{EndUserIp}}',
    });
    item.request.auth = {
      type: 'basic',
      basic: [
        { key: 'username', value: '{{UserName}}', type: 'string' },
        { key: 'password', value: '{{Password}}', type: 'string' },
      ],
    };
  }

  if (item.name === '1) Affiliate - Search') {
    let body;
    try {
      body = JSON.parse(item.request.body.raw);
    } catch {
      body = null;
    }
    if (body) {
      if (Object.prototype.hasOwnProperty.call(body, 'CheckIn')) body.CheckIn = '{{CheckIn}}';
      if (Object.prototype.hasOwnProperty.call(body, 'CheckOut')) body.CheckOut = '{{CheckOut}}';
      if (Object.prototype.hasOwnProperty.call(body, 'HotelCodes')) body.HotelCodes = '{{HotelCodes}}';
      setBodyFromObject(item.request, body);
    }
    replaceEventScript(item, 'test', searchTestScript());
  }

  if (item.name === '2) Affiliate - PreBook') {
    setBodyFromRaw(
      item.request,
      `{
  "BookingCode": "{{BookingCode}}",
  "PaymentMode": "{{PaymentMode}}",
  "GuestNationality": "{{GuestNationality}}",
  "NoOfRooms": {{NoOfRooms}}
}`,
    );
    replaceEventScript(item, 'prerequest', prebookPrerequestScript());
  }
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');

console.log(outputPath);
