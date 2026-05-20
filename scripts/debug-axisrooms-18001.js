const mysql = require('mysql2/promise');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

const QUOTE_ID = process.argv[2] || 'DVI20260589';
const HOTEL_ID = Number(process.argv[3] || 153);
const API_URL = process.env.DEBUG_API_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN = process.env.DEBUG_BEARER_TOKEN || process.argv[4] || '';

function extractAxisroomsRate(occupancyRates) {
  try {
    if (!occupancyRates || typeof occupancyRates !== 'object') return 0;

    const preferredKeys = ['SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD', 'EXTRABED'];
    for (const key of preferredKeys) {
      const value = Number(occupancyRates[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }

    for (const value of Object.values(occupancyRates)) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
  } catch {
    return 0;
  }

  return 0;
}

async function query(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function main() {
  const conn = await mysql.createConnection('mysql://dvi_user:myDvi123!@localhost:3306/dvi_main');

  try {
    console.log(`=== Debug AxisRooms vs 18001 for quote ${QUOTE_ID}, hotel ${HOTEL_ID} ===`);

    const planRows = await query(
      conn,
      `SELECT itinerary_plan_ID, no_of_nights
       FROM dvi_itinerary_plan_details
       WHERE itinerary_quote_ID = ? AND deleted = 0`,
      [QUOTE_ID],
    );
    if (!planRows.length) {
      throw new Error(`Quote not found: ${QUOTE_ID}`);
    }

    const planId = Number(planRows[0].itinerary_plan_ID);
    const routeRows = await query(
      conn,
      `SELECT itinerary_route_ID, location_name, next_visiting_location, itinerary_route_date
       FROM dvi_itinerary_route_details
       WHERE itinerary_plan_ID = ? AND deleted = 0 AND status = 1
       ORDER BY itinerary_route_ID ASC`,
      [planId],
    );

    console.log('\nRoutes in itinerary:');
    console.table(routeRows.map((row) => ({
      routeId: Number(row.itinerary_route_ID),
      date: row.itinerary_route_date,
      destination: row.next_visiting_location || row.location_name,
    })));

    const munnarRoutes = routeRows.filter((row) =>
      String(row.next_visiting_location || row.location_name || '').toLowerCase().includes('munnar'),
    );

    console.log('\nMunnar route candidates:');
    console.table(munnarRoutes.map((row) => ({
      routeId: Number(row.itinerary_route_ID),
      date: row.itinerary_route_date,
      destination: row.next_visiting_location || row.location_name,
    })));

    const ratePlans = await query(
      conn,
      `SELECT hotel_id, room_id, rateplan_id, rateplan_name, meal_plan_description, axisrooms_room_id
       FROM dvi_hotel_room_rate_plan
       WHERE hotel_id = ?
         AND axisrooms_room_id IS NOT NULL
         AND deleted = 0
         AND status = 1
       ORDER BY room_id, rateplan_id`,
      [HOTEL_ID],
    );

    console.log('\nActive AxisRooms rate plans:');
    console.table(ratePlans);

    const roomAvailability = await query(
      conn,
      `SELECT hotel_id, room_id, free, start_date, end_date
       FROM dvi_hotel_room_availability
       WHERE hotel_id = ?
         AND free > 0
       ORDER BY room_id, start_date`,
      [HOTEL_ID],
    );

    console.log('\nRoom availability rows for hotel:');
    console.table(roomAvailability.map((row) => ({
      hotel_id: Number(row.hotel_id),
      room_id: Number(row.room_id),
      free: Number(row.free),
      start_date: row.start_date,
      end_date: row.end_date,
    })));

    const occupancyRows = await query(
      conn,
      `SELECT hotel_id, room_id, rateplan_id, start_date, end_date, occupancy_rates
       FROM dvi_hotel_occupancy_rate
       WHERE hotel_id = ?
       ORDER BY room_id, rateplan_id, start_date`,
      [HOTEL_ID],
    );

    const extractedRows = occupancyRows.map((row) => ({
      hotel_id: Number(row.hotel_id),
      room_id: Number(row.room_id),
      rateplan_id: String(row.rateplan_id),
      start_date: row.start_date,
      end_date: row.end_date,
      extracted_rate: extractAxisroomsRate(row.occupancy_rates),
      occupancy_rates: JSON.stringify(row.occupancy_rates),
    }));

    console.log('\nOccupancy rows with extracted AxisRooms rate:');
    console.table(extractedRows);

    let apiHotels = [];
    if (AUTH_TOKEN) {
      const response = await axios.get(`${API_URL}/itineraries/hotel_details/${QUOTE_ID}`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      apiHotels = Array.isArray(response.data?.hotels) ? response.data.hotels : [];
    } else {
      console.log('\nNo bearer token supplied. Skipping API verification.');
    }

    if (apiHotels.length > 0) {
      const matchingRows = apiHotels.filter((row) => {
        const name = String(row.hotelName || '').toLowerCase();
        return Number(row.hotelId) === HOTEL_ID || name.includes('munnar queen');
      });

      console.log('\nAPI rows matching hotelId=153 or hotel name containing "Munnar Queen":');
      console.table(matchingRows.map((row) => ({
        itineraryRouteId: Number(row.itineraryRouteId),
        groupType: Number(row.groupType),
        hotelName: row.hotelName,
        hotelId: Number(row.hotelId),
        totalHotelCost: Number(row.totalHotelCost),
        provider: row.provider,
        bookingCode: row.bookingCode,
        searchReference: row.searchReference,
      })));

      const axRows = matchingRows.filter((row) => String(row.provider).toLowerCase() === 'axisrooms');
      const nonAxRows = matchingRows.filter((row) => String(row.provider).toLowerCase() !== 'axisrooms');

      console.log('\nSummary:');
      if (axRows.length > 0) {
        const prices = [...new Set(axRows.map((row) => Number(row.totalHotelCost)))];
        console.log(`AxisRooms prices for hotel ${HOTEL_ID}: ${prices.join(', ')}`);
      } else {
        console.log(`AxisRooms prices for hotel ${HOTEL_ID}: none in API response`);
      }

      const exact18001 = matchingRows.filter((row) => Number(row.totalHotelCost) === 18001);
      if (exact18001.length > 0) {
        console.log('\nRows with totalHotelCost = 18001:');
        console.table(exact18001.map((row) => ({
          itineraryRouteId: Number(row.itineraryRouteId),
          groupType: Number(row.groupType),
          hotelName: row.hotelName,
          hotelId: Number(row.hotelId),
          provider: row.provider,
          bookingCode: row.bookingCode,
        })));
      } else {
        console.log('\nNo API rows currently return totalHotelCost = 18001 for the Munnar Queen matches.');
      }

      if (nonAxRows.length > 0) {
        console.log('\nReason: rows with higher Munnar Queen prices are coming from non-AxisRooms providers using different hotel codes.');
        const grouped = new Map();
        for (const row of nonAxRows) {
          const key = `${row.provider}|${row.hotelId}|${row.hotelName}`;
          if (!grouped.has(key)) grouped.set(key, new Set());
          grouped.get(key).add(Number(row.totalHotelCost));
        }
        for (const [key, prices] of grouped.entries()) {
          console.log(`  ${key} => prices ${Array.from(prices).sort((a, b) => a - b).join(', ')}`);
        }
      }
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});