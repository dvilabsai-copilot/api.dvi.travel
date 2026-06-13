require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function maskPayload(payload) {
  return { ...payload, apikey: '***MASKED***' };
}

async function main() {
  const outputDir = path.join(__dirname, '..', 'debug-output', 'hotel-voucher-cancel-9581');
  fs.mkdirSync(outputDir, { recursive: true });

  const confirmedPlan = await prisma.dvi_confirmed_itinerary_plan_details.findFirst({
    where: { itinerary_plan_ID: 9581 },
    orderBy: { confirmed_itinerary_plan_ID: 'desc' },
  });

  const confirmation = await prisma.staah_hotel_booking_confirmation.findFirst({
    where: {
      OR: [
        { itinerary_plan_ID: 9581 },
        confirmedPlan
          ? { confirmed_itinerary_plan_ID: confirmedPlan.confirmed_itinerary_plan_ID }
          : { confirmed_itinerary_plan_ID: -1 },
      ],
      status: 1,
      deleted: 0,
    },
    orderBy: { staah_hotel_booking_confirmation_ID: 'desc' },
  });

  if (!confirmation) {
    const evidence = {
      itineraryPlanId: 9581,
      confirmedItineraryPlanId: confirmedPlan?.confirmed_itinerary_plan_ID || null,
      foundConfirmation: false,
      message: 'No active STAAH booking confirmation row exists locally for itinerary 9581.',
    };
    fs.writeFileSync(
      path.join(outputDir, 'direct-cancel.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  const confirmRequest = confirmation?.api_response?.confirm?.request;
  if (!confirmRequest || typeof confirmRequest !== 'object') {
    const evidence = {
      itineraryPlanId: 9581,
      confirmationId: confirmation.staah_hotel_booking_confirmation_ID,
      foundConfirmation: true,
      foundConfirmRequest: false,
      message: 'STAAH confirmation exists but api_response.confirm.request is missing.',
    };
    fs.writeFileSync(
      path.join(outputDir, 'direct-cancel.json'),
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  const cancelPayload = JSON.parse(JSON.stringify(confirmRequest));
  cancelPayload.action = 'reservation_info';
  cancelPayload.apikey = process.env.STAAH_API_KEY || '';
  cancelPayload.propertyid =
    cancelPayload.propertyid ||
    (await prisma.dvi_hotel.findFirst({
      where: { hotel_id: Number(confirmation.staah_hotel_code || 0) || -1 },
      select: { staah_property_id: true },
    }))?.staah_property_id ||
    '';

  if (cancelPayload?.reservations?.reservation?.[0]) {
    cancelPayload.reservations.reservation[0].status = 'Cancel';
  }

  const apiUrl =
    process.env.STAAH_BOOKING_API_URL ||
    'https://reservation.otaswitch.com/getapi/reservation/v2';

  let result;
  try {
    const response = await axios.post(apiUrl, cancelPayload, {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      validateStatus: () => true,
    });
    result = {
      status: response.status,
      body: response.data,
    };
  } catch (error) {
    result = {
      status: error?.response?.status || null,
      body: error?.response?.data || null,
      error: error?.message || String(error),
    };
  }

  const evidence = {
    itineraryPlanId: 9581,
    confirmedItineraryPlanId: confirmation.confirmed_itinerary_plan_ID,
    confirmationId: confirmation.staah_hotel_booking_confirmation_ID,
    bookingReference: confirmation.staah_booking_reference,
    cancelUrl: apiUrl,
    payload: maskPayload(cancelPayload),
    result,
  };

  fs.writeFileSync(
    path.join(outputDir, 'direct-cancel.json'),
    JSON.stringify(evidence, null, 2),
  );

  console.log('Cancel URL:', apiUrl);
  console.log('Payload:', JSON.stringify(maskPayload(cancelPayload), null, 2));
  console.log('Result:', JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error('debug-staah-direct-cancel failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
