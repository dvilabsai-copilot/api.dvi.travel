#!/usr/bin/env node

const axios = require('axios');

const API_URL =
  process.env.CONFIRM_QUOTATION_URL ||
  'http://127.0.0.1:4006/api/v1/itineraries/confirm-quotation';

const AUTH_TOKEN =
  process.env.CONFIRM_QUOTATION_TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODA3NzMwNzYsImV4cCI6MTc4MTM3Nzg3Nn0.el4nJQV6crdztkcV7A4oCQxJ_FrfrGtOfFZFJGFf1lQ';

const payload = {
  itinerary_plan_ID: 9557,
  agent: 8,
  primary_guest_salutation: 'Mr',
  primary_guest_name: 'yest',
  primary_guest_contact_no: '123',
  primary_guest_age: '35',
  primary_guest_alternative_contact_no: '',
  primary_guest_email_id: '',
  adult_name: [],
  adult_age: [],
  child_name: [],
  child_age: [],
  infant_name: [],
  infant_age: [],
  arrival_date_time: '14-07-2026 1:30 PM',
  arrival_place: 'Cochin International Airport',
  arrival_flight_details: '',
  departure_date_time: '17-07-2026 1:30 AM',
  departure_place: 'Cochin International Airport',
  departure_flight_details: '',
  price_confirmation_type: 'new',
  hotel_group_type: '1',
  hotel_bookings: [
    {
      occupancies: [{ adults: 1, children: 0, childrenAges: [] }],
      provider: 'staah',
      routeId: 4264,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44588',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-07-14',
      checkOutDate: '2026-07-15',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 1098,
      passengers: [
        {
          title: 'Mr',
          firstName: 'yest',
          lastName: 'yest',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 35,
          phoneNo: '123',
        },
      ],
    },
    {
      occupancies: [{ adults: 1, children: 0, childrenAges: [] }],
      provider: 'staah',
      routeId: 4265,
      hotelCode: '44588',
      hotelName: 'STAAH TEST HOTEL',
      bookingCode: '44588',
      roomType: 'Deluxe Room - Test',
      checkInDate: '2026-07-15',
      checkOutDate: '2026-07-16',
      numberOfRooms: 1,
      guestNationality: 'IN',
      netAmount: 1098,
      passengers: [
        {
          title: 'Mr',
          firstName: 'yest',
          lastName: 'yest',
          nationality: 'IN',
          paxType: 1,
          leadPassenger: true,
          age: 35,
          phoneNo: '123',
        },
      ],
    },
  ],
  selected_hotel_route_ids: [4264, 4265],
  external_stay_route_ids: [],
  primaryGuest: {
    salutation: 'Mr',
    name: 'yest',
    phone: '123',
    email: '',
  },
  endUserIp: '139.5.249.145',
};

async function main() {
  try {
    const response = await axios.post(API_URL, payload, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000,
      validateStatus: () => true,
    });

    console.log(`HTTP ${response.status}`);
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('trigger-staah-confirm-9557 failed:', error.message || error);
    process.exitCode = 1;
  }
}

main();
