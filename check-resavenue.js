/**
 * ResAvenue Diagnostic Script
 * Tests DB state and live API calls
 */
const axios = require('axios');

const BASE_URL = 'https://cm.resavenue.com/channelcontroller';
const USERNAME = 'crm.dvi@dvi.co.in';
const PASSWORD = 'Dviholidays@882';
const ID_CONTEXT = 'REV';

const CHECKIN = '2026-06-15';
const CHECKOUT = '2026-06-17';

// Hotels from DB
const HOTELS = [
  { code: '18', name: 'Poppys Hotel Madurai', city: 'Madurai' },
  { code: '20', name: 'Vinayaga by Poppys Rameswaram', city: 'Rameswaram' },
  { code: '21', name: 'Vinayaga by Poppys Kumbakonam', city: 'Kumbakonam' },
  { code: '22', name: 'Vinayaga Inn by Poppys Ooty', city: 'Uthagamandalam' },
  { code: '261', name: 'PMS Test Hotel', city: 'Gwalior' },
  { code: '285', name: 'TM Globus', city: 'Darjiling' },
  { code: '1098', name: 'TMahal Palace', city: 'Mumbai' },
  { code: '1294', name: 'Tuskers Hill by Poppys', city: 'Thrissur' },
  { code: '3097', name: 'Poppys Olive De Villa', city: 'Vellore' },
  { code: '4543', name: 'Tuskers Hill Banquets by Poppys', city: 'Thrissur' },
];

async function testPropertyDetails(hotelCode) {
  try {
    const response = await axios.post(
      `${BASE_URL}/PropertyDetails`,
      {
        OTA_HotelDetailsRQ: {
          POS: {
            Username: USERNAME,
            Password: PASSWORD,
            ID_Context: ID_CONTEXT,
          },
          TimeStamp: '20261015T15:22:50',
          EchoToken: `details-${Date.now()}`,
          HotelCode: hotelCode,
        },
      },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 30000,
      }
    );

    const data = response.data?.OTA_HotelDetailsRS?.[0];
    if (!data) return { ok: false, reason: 'No OTA_HotelDetailsRS[0] in response', raw: JSON.stringify(response.data).substring(0, 300) };

    const roomTypes = (data.RoomTypes || []).filter(r => r.room_status === 'active');
    return {
      ok: true,
      totalRooms: (data.RoomTypes || []).length,
      activeRooms: roomTypes.length,
      rooms: roomTypes.map(r => ({
        id: r.room_id,
        name: r.room_name,
        status: r.room_status,
        ratePlans: (r.RatePlans || []).filter(rp => rp.rate_status === 'active').length,
      })),
    };
  } catch (err) {
    return { ok: false, reason: err.message, status: err.response?.status, data: JSON.stringify(err.response?.data || {}).substring(0, 300) };
  }
}

async function testInventory(hotelCode, invCodes) {
  try {
    const response = await axios.post(
      `${BASE_URL}/PropertyDetails`,
      {
        OTA_HotelInventoryRQ: {
          POS: { Username: USERNAME, Password: PASSWORD, ID_Context: ID_CONTEXT },
          TimeStamp: '20261015T15:22:50',
          EchoToken: `inv-${Date.now()}`,
          HotelCode: hotelCode,
          Start: CHECKIN,
          End: CHECKOUT,
          InvCodes: invCodes,
        },
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000 }
    );

    const inventories = response.data?.OTA_HotelInventoryRS?.Inventories || [];
    return {
      ok: true,
      inventoryCount: inventories.length,
      available: inventories.map(inv => ({
        invCode: inv.InvCode,
        dates: (inv.Inventory || []).map(d => ({ date: d.Date, count: d.InvCount, stopSell: d.StopSell })),
      })),
    };
  } catch (err) {
    return { ok: false, reason: err.message, status: err.response?.status };
  }
}

async function testRates(hotelCode, rateCodes) {
  try {
    const response = await axios.post(
      `${BASE_URL}/PropertyDetails`,
      {
        OTA_HotelRateRQ: {
          POS: { Username: USERNAME, Password: PASSWORD, ID_Context: ID_CONTEXT },
          HotelCode: hotelCode,
          Start: CHECKIN,
          End: CHECKOUT,
          RateCodes: rateCodes,
        },
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000 }
    );

    const rates = response.data?.OTA_HotelRateRS?.Rates || [];
    return {
      ok: true,
      rateCount: rates.length,
      rates: rates.map(r => ({
        rateCode: r.RateCode,
        dates: (r.Rate || []).map(d => ({ date: d.Date, single: d.Single, double: d.Double, stopSell: d.StopSell })),
      })),
    };
  } catch (err) {
    return { ok: false, reason: err.message, status: err.response?.status };
  }
}

async function checkTBOCityResolution() {
  try {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

    // Check a common TBO city code and what city it maps to
    const [rows] = await conn.query('SELECT tbo_city_code, name FROM dvi_cities WHERE name IN (?, ?, ?, ?) LIMIT 20', ['Madurai', 'Mumbai', 'Thrissur', 'Vellore']);
    console.log('\n=== TBO City Code Mappings ===');
    rows.forEach(r => console.log(` ${r.name} -> tbo_city_code: ${r.tbo_city_code}`));

    // Also check if hotel cities match exactly  
    const [hotels] = await conn.query(
      'SELECT h.hotel_name, h.hotel_city, h.resavenue_hotel_code, c.tbo_city_code FROM dvi_hotel h LEFT JOIN dvi_cities c ON c.name = h.hotel_city WHERE h.resavenue_hotel_code IS NOT NULL AND h.deleted=0 AND h.status=1'
    );
    console.log('\n=== Hotel City-to-TBO-Code Mapping ===');
    hotels.forEach(h => console.log(` [${h.resavenue_hotel_code}] ${h.hotel_name} | city="${h.hotel_city}" | tbo_city_code=${h.tbo_city_code}`));

    await conn.end();
  } catch (e) {
    console.error('DB check failed:', e.message);
  }
}

async function main() {
  console.log('=== ResAvenue Diagnostic Tool ===');
  console.log(`Dates: ${CHECKIN} -> ${CHECKOUT}\n`);

  // 1. Check DB + city resolution  
  await checkTBOCityResolution();

  // 2. Test a few hotels via API
  const testHotels = HOTELS.slice(0, 3); // Test first 3
  console.log('\n=== ResAvenue API Tests ===');

  for (const hotel of testHotels) {
    console.log(`\n--- Hotel: ${hotel.name} (code: ${hotel.code}) ---`);

    const pd = await testPropertyDetails(hotel.code);
    console.log('PropertyDetails:', JSON.stringify(pd, null, 2));

    if (pd.ok && pd.activeRooms > 0) {
      // Get first room's invCode and rateCode
      const firstRoom = pd.rooms[0];
      console.log(`Testing inventory for invCode ${firstRoom.id}...`);
      const inv = await testInventory(hotel.code, [firstRoom.id]);
      console.log('Inventory:', JSON.stringify(inv, null, 2));

      // Also get rate codes
      const pdDetails = await testPropertyDetailsRaw(hotel.code);
      const rateCodes = [];
      if (pdDetails) {
        (pdDetails.RoomTypes || []).forEach(rt => {
          (rt.RatePlans || []).filter(rp => rp.rate_status === 'active').forEach(rp => rateCodes.push(rp.rate_id));
        });
      }

      if (rateCodes.length > 0) {
        console.log(`Testing rates for first rateCode ${rateCodes[0]}...`);
        const rates = await testRates(hotel.code, [rateCodes[0]]);
        console.log('Rates:', JSON.stringify(rates, null, 2));
      }
    }
  }
}

// Helper to get raw property details
async function testPropertyDetailsRaw(hotelCode) {
  try {
    const response = await axios.post(
      `${BASE_URL}/PropertyDetails`,
      {
        OTA_HotelDetailsRQ: {
          POS: { Username: USERNAME, Password: PASSWORD, ID_Context: ID_CONTEXT },
          TimeStamp: '20261015T15:22:50',
          EchoToken: `details-${Date.now()}`,
          HotelCode: hotelCode,
        },
      },
      { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000 }
    );
    return response.data?.OTA_HotelDetailsRS?.[0] || null;
  } catch { return null; }
}

main().catch(console.error);
