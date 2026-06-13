require('dotenv').config();
const fs = require('fs');
const path = require('path');

const TOKEN =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODA3NzMwNzYsImV4cCI6MTc4MTM3Nzg3Nn0.el4nJQV6crdztkcV7A4oCQxJ_FrfrGtOfFZFJGFf1lQ';

const url = 'http://127.0.0.1:4006/api/v1/itineraries/9581/hotel-vouchers';
const body = {
  itineraryPlanId: 9581,
  vouchers: [
    {
      routeId: 4650,
      hotelId: 0,
      hotelDetailsIds: [5693],
      routeDates: ['2026-06-18'],
      confirmedBy: 'kkk',
      emailId: 'vendor@dotrip.net',
      mobileNumber: '4234234',
      status: 'cancelled',
      invoiceTo: 'gst_bill_against_dvi',
      voucherTermsCondition:
        '&lt;p&gt;&lt;span style=&quot;color:rgb(0,32,96);&quot;&gt;&lt;strong&gt;Package&nbsp; Includes: (Inclusion)&lt;/strong&gt;&lt;/span&gt;&lt;br&gt;&lt;span style=&quot;color:rgb(0,32,96);&quot;&gt;All Hotel Taxes &amp; Service Taxes&lt;/span&gt;&lt;/p&gt;',
    },
  ],
};

async function main() {
  const outputDir = path.join(__dirname, '..', 'debug-output', 'hotel-voucher-cancel-9581');
  fs.mkdirSync(outputDir, { recursive: true });

  const requestEvidence = {
    url,
    method: 'POST',
    headers: {
      Authorization: TOKEN.slice(0, 24) + '...masked',
      'Content-Type': 'application/json',
    },
    body,
    note: 'Empty-body test skipped because createHotelVouchers reads dto.vouchers.length directly and does not accept an empty body shape.',
  };

  console.log('Request URL:', url);
  console.log('Request Body:', JSON.stringify(body, null, 2));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch (error) {
    responseJson = null;
  }

  const responseEvidence = {
    status: response.status,
    ok: response.ok,
    body: responseJson || responseText,
  };

  fs.writeFileSync(
    path.join(outputDir, 'request.json'),
    JSON.stringify(requestEvidence, null, 2),
  );
  fs.writeFileSync(
    path.join(outputDir, 'response.json'),
    JSON.stringify(responseEvidence, null, 2),
  );

  console.log('Response Status:', response.status);
  console.log('Response Body:', JSON.stringify(responseJson || responseText, null, 2));
}

main().catch((error) => {
  console.error('debug-hotel-voucher-cancel failed:', error);
  process.exitCode = 1;
});
