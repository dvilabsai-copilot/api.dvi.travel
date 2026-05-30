const url = 'https://dvi.travel/api/v1/itineraries/409/hotel-vouchers';

const token =
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzc5NTIxOTEsImV4cCI6MTc4MDU1Njk5MX0.wdiVUrWuBJXHFd_F8fzkealafEgBunniNddktotkWIo';

const payload = {
  itineraryPlanId: 409,
  vouchers: [
    {
      routeId: 2838,
      hotelId: 44588,
      hotelDetailsIds: [0],
      routeDates: ['2026-06-01'],
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

(async () => {
  try {
    console.log('--- REQUEST URL ---');
    console.log(url);

    console.log('\n--- REQUEST PAYLOAD ---');
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        Authorization: token,
      },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }

    console.log('\n--- HTTP STATUS ---');
    console.log(response.status, response.statusText);

    console.log('\n--- FULL RESPONSE ---');
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));

    console.log(
      `\nRESULT: ${
        response.ok && data && data.success ? 'SUCCESS' : 'FAILURE'
      } - hotel-vouchers ${response.ok ? 'responded' : 'failed'}`
    );
  } catch (error) {
    console.error('\nRESULT: FAILURE - request error');
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
})();
