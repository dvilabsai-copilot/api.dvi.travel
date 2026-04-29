/**
 * Script: find-south-india-amenities.js
 *
 * Requested flow:
 * 1) CityId -> hotel codes (TBO static API)
 * 2) Search by hotel code(s)
 * 3) Take first BookingCode per hotel
 * 4) Call PreBook (authoritative for Amenities)
 * 5) Print city + hotel name + hotel code when amenities exist
 *
 * Usage:
 *   node scripts/find-south-india-amenities.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');

const STATIC_BASE = 'http://api.tbotechnology.in/TBOHolidays_HotelAPI';
const SEARCH_URL = 'https://affiliate.tektravels.com/HotelAPI/Search';
const PREBOOK_URL = 'https://affiliate.tektravels.com/HotelAPI/PreBook';

const STATIC_BASIC = `Basic ${Buffer.from('TBOStaticAPITest:Tbo@11530818').toString('base64')}`;
const AFFILIATE_USER = process.env.TBO_API_USERNAME || process.env.TBO_USERNAME || 'Doview';
const AFFILIATE_PASS = process.env.TBO_API_PASSWORD || process.env.TBO_PASSWORD || 'Doview@12345';
const AFFILIATE_BASIC = `Basic ${Buffer.from(`${AFFILIATE_USER}:${AFFILIATE_PASS}`).toString('base64')}`;

const TARGET_CITY_KEYWORDS = ['chennai', 'kochi', 'pondicherry', 'puducherry'];

const MAX_HOTEL_CODES_PER_CITY = Number(process.env.MAX_HOTEL_CODES_PER_CITY || 120);
const MAX_PREBOOKS_PER_CITY = Number(process.env.MAX_PREBOOKS_PER_CITY || 12);

function searchDates() {
  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 35);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);

  const ymd = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  return { checkIn: ymd(checkIn), checkOut: ymd(checkOut) };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getIndiaCities() {
  const res = await axios.post(
    `${STATIC_BASE}/CityList`,
    { CountryCode: 'IN' },
    { timeout: 30000, headers: { 'Content-Type': 'application/json', Authorization: STATIC_BASIC } },
  );
  return Array.isArray(res.data?.CityList) ? res.data.CityList : [];
}

async function getHotelCatalogForCity(cityCode) {
  const res = await axios.post(
    `${STATIC_BASE}/TBOHotelCodeList`,
    { CityCode: String(cityCode) },
    { timeout: 30000, headers: { 'Content-Type': 'application/json', Authorization: STATIC_BASIC } },
  );
  return Array.isArray(res.data?.Hotels) ? res.data.Hotels : [];
}

async function searchHotelsByCodes(hotelCodesCsv, checkIn, checkOut) {
  const payload = {
    CheckIn: checkIn,
    CheckOut: checkOut,
    HotelCodes: hotelCodesCsv,
    GuestNationality: 'IN',
    NoOfRooms: 1,
    PaxRooms: [{ Adults: 1, Children: 0, ChildrenAges: [] }],
    ResponseTime: 23,
    IsDetailedResponse: true,
  };

  const res = await axios.post(SEARCH_URL, payload, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json', Authorization: AFFILIATE_BASIC },
  });

  return Array.isArray(res.data?.HotelResult) ? res.data.HotelResult : [];
}

async function prebook(bookingCode) {
  const payload = {
    BookingCode: bookingCode,
    PaymentMode: 'Limit',
    GuestNationality: 'IN',
    NoOfRooms: 1,
    PaxRooms: [{ Adults: 1, Children: 0, ChildrenAges: [] }],
  };

  const res = await axios.post(PREBOOK_URL, payload, {
    timeout: 90000,
    headers: { 'Content-Type': 'application/json', Authorization: AFFILIATE_BASIC },
  });

  return res.data;
}

async function main() {
  const { checkIn, checkOut } = searchDates();
  console.log(`Using dates: ${checkIn} -> ${checkOut}`);

  const allCities = await getIndiaCities();
  const cities = allCities.filter((c) => {
    const name = String(c.Name || '').toLowerCase();
    return TARGET_CITY_KEYWORDS.some((k) => name.includes(k));
  });

  if (!cities.length) {
    console.log('No target cities found in CityList response.');
    return;
  }

  console.log('Target cities:');
  cities.forEach((c) => console.log(`- ${c.Name} (CityCode=${c.Code})`));

  const finalRows = [];

  for (const city of cities) {
    const cityName = city.Name;
    const cityCode = city.Code;

    console.log(`\n=== ${cityName} (${cityCode}) ===`);

    let catalog;
    try {
      catalog = await getHotelCatalogForCity(cityCode);
    } catch (err) {
      console.log(`Hotel catalog failed: ${err.message}`);
      continue;
    }

    if (!catalog.length) {
      console.log('No hotels in catalog for this city.');
      continue;
    }

    const sampleCatalog = catalog.slice(0, MAX_HOTEL_CODES_PER_CITY);
    const codeBatches = chunk(sampleCatalog, 30);
    const searchHotels = [];

    for (const batch of codeBatches) {
      const codesCsv = batch.map((h) => h.HotelCode).filter(Boolean).join(',');
      if (!codesCsv) continue;

      try {
        const found = await searchHotelsByCodes(codesCsv, checkIn, checkOut);
        searchHotels.push(...found);
      } catch (err) {
        console.log(`Search batch failed: ${err.message}`);
      }
      await sleep(500);
    }

    console.log(`Search returned ${searchHotels.length} hotels (from ${sampleCatalog.length} catalog codes).`);

    if (!searchHotels.length) {
      continue;
    }

    let done = 0;
    for (const hotel of searchHotels) {
      if (done >= MAX_PREBOOKS_PER_CITY) break;

      const firstBookingCode = hotel?.Rooms?.[0]?.BookingCode;
      if (!firstBookingCode) continue;

      const catalogMatch = sampleCatalog.find((x) => x.HotelCode === hotel.HotelCode);
      const hotelName = catalogMatch?.HotelName || '(name not returned)';

      try {
        const prebookResp = await prebook(firstBookingCode);
        const prebookHotel = prebookResp?.HotelResult?.[0];
        const room = prebookHotel?.Rooms?.[0];
        const amenities = Array.isArray(room?.Amenities) ? room.Amenities : [];

        if (amenities.length > 0) {
          finalRows.push({
            city: cityName,
            cityCode,
            hotelCode: prebookHotel?.HotelCode || hotel.HotelCode,
            hotelName,
            firstBookingCode,
            amenitiesCount: amenities.length,
          });
          console.log(`  OK ${hotelName} | HotelCode=${prebookHotel?.HotelCode || hotel.HotelCode} | Amenities=${amenities.length}`);
        } else {
          console.log(`  NO_AMENITIES ${hotelName} | HotelCode=${hotel.HotelCode}`);
        }
      } catch (err) {
        console.log(`  PREBOOK_FAIL ${hotelName} | HotelCode=${hotel.HotelCode} | ${err.message}`);
      }

      done += 1;
      await sleep(600);
    }
  }

  console.log('\n============================================================');
  console.log('PREBOOK RESULTS (authoritative amenities source)');
  console.log('============================================================');

  if (!finalRows.length) {
    console.log('No hotels with amenities found in processed set.');
    return;
  }

  const grouped = {};
  for (const row of finalRows) {
    if (!grouped[row.city]) grouped[row.city] = [];
    grouped[row.city].push(row);
  }

  for (const cityName of Object.keys(grouped)) {
    console.log(`\n--- ${cityName} ---`);
    grouped[cityName].forEach((r, idx) => {
      console.log(`${idx + 1}. ${r.hotelName}`);
      console.log(`   HotelCode: ${r.hotelCode}`);
      console.log(`   Amenities: ${r.amenitiesCount}`);
      console.log(`   FirstBookingCode: ${r.firstBookingCode}`);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
