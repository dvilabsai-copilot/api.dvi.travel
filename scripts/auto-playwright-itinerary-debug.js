const { chromium } = require('playwright');

(async () => {
  const LOGIN_EMAIL = 'admin@dvi.co.in';
  const LOGIN_PASSWORD = 'Keerthi@2404ias';
  const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODEzNzgwOTcsImV4cCI6MTc4MTk4Mjg5N30.SyGkfVJmzJCFmm28Wv67Ut4Zad2qYAfEuIBn_5jzLgE';
  const TARGET_URL = 'http://localhost:8080/itinerary-details/DVI20260660';

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  await context.addInitScript((token) => {
    localStorage.setItem('accessToken', token);
  }, ACCESS_TOKEN);

  const page = await context.newPage();
  page.setDefaultTimeout(5000);

  const requestCounts = {
    details: 0,
    status: 0,
    permitSync: 0,
    vehicleSync: 0,
  };

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/v1/itineraries/details/')) {
      requestCounts.details += 1;
      console.log('[REQ][DETAILS]', request.method(), url);
    }
    if (url.includes('/api/v1/itineraries/') && url.includes('/vehicle-build-status')) {
      requestCounts.status += 1;
      console.log('[REQ][STATUS]', request.method(), url);
    }
    if (url.includes('/api/v1/itineraries/') && url.includes('/permit-build-sync')) {
      requestCounts.permitSync += 1;
      console.log('[REQ][PERMIT]', request.method(), url);
    }
    if (url.includes('/api/v1/itineraries/') && url.includes('/vehicle-build-sync')) {
      requestCounts.vehicleSync += 1;
      console.log('[REQ][VEHICLE]', request.method(), url);
    }
  });

  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/v1/itineraries/details/') || url.includes('/vehicle-build-status') || url.includes('/permit-build-sync') || url.includes('/vehicle-build-sync')) {
      console.log('[RES]', response.status(), url);
    }
  });

  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(1000);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const loaderVisible = await page.locator('text=Building itinerary details').count().catch(() => 0);
    const titleVisible = await page.locator('text=Tour Itinerary Plan').count().catch(() => 0);
    const vehicleLoaderVisible = await page.locator('text=Preparing vehicle details and pricing. Please wait...').count().catch(() => 0);
    console.log('[TICK]', {
      second: i + 1,
      loaderVisible,
      titleVisible,
      vehicleLoaderVisible,
      bodyPreview: bodyText.slice(0, 180).replace(/\n+/g, ' | '),
    });
  }

  console.log('[COUNTS]', requestCounts);
  await browser.close();
})();
