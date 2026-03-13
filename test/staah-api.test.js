// STAAH API Test Suite
// Run with: node test/staah-api.test.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE_URL = process.env.BASE_URL || 'https://dvi.travel';
const API_PREFIX = process.env.API_PREFIX || '/api/v1';
const API_KEY = process.env.STAAH_API_KEY || 'test-key-12345';
const PROPERTY_ID = process.env.STAAH_PROPERTY_ID || 'STAAH_TEST_HOTEL_1';
const ROOM_ID = process.env.STAAH_ROOM_ID || 'DELUXE_ROOM';
const RATEPLAN_ID = process.env.STAAH_RATEPLAN_ID || 'CP_PLAN';
const REQUIRE_VALID_PROPERTY = String(process.env.STAAH_REQUIRE_VALID_PROPERTY || 'false').toLowerCase() === 'true';
const LOG_OUTPUT_DIR = process.env.LOG_OUTPUT_DIR || '';
const LOG_DIR_PATH = LOG_OUTPUT_DIR
  ? path.resolve(__dirname, LOG_OUTPUT_DIR)
  : __dirname;

if (!fs.existsSync(LOG_DIR_PATH)) {
  fs.mkdirSync(LOG_DIR_PATH, { recursive: true });
}

const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: [],
};

function saveToFile(filename, requestData, responseData, error = null) {
  const timestamp = new Date().toISOString();
  const sanitizedFilename = filename.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.txt';
  const filePath = path.join(LOG_DIR_PATH, sanitizedFilename);

  let content = `============================================================\n`;
  content += `STAAH API Test Log\n`;
  content += `============================================================\n`;
  content += `Test Name: ${filename}\n`;
  content += `Timestamp: ${timestamp}\n`;
  content += `Status: ${error ? 'FAILED' : 'SUCCESS'}\n`;
  content += `============================================================\n\n`;

  content += `REQUEST:\n`;
  content += `--------\n`;
  content += `URL: ${requestData.url}\n`;
  content += `Method: ${requestData.method || 'POST'}\n`;
  content += `Headers:\n${JSON.stringify(requestData.headers || {}, null, 2)}\n\n`;
  content += `Body:\n${JSON.stringify(requestData.body, null, 2)}\n\n`;

  content += `RESPONSE:\n`;
  content += `---------\n`;
  if (error) {
    content += `Status: ${error.response?.status || 'N/A'}\n`;
    content += `Error: ${error.message}\n\n`;
    content += `Response Data:\n${JSON.stringify(error.response?.data || {}, null, 2)}\n`;
  } else {
    content += `Status: ${responseData.status}\n`;
    content += `Headers:\n${JSON.stringify(responseData.headers || {}, null, 2)}\n\n`;
    content += `Data:\n${JSON.stringify(responseData.data, null, 2)}\n`;
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`   Saved to: ${path.relative(__dirname, filePath)}`);
}

async function runTest(name, testFn) {
  try {
    console.log(`\nRunning: ${name}`);
    await testFn();
    results.passed++;
    results.tests.push({ name, status: 'PASSED' });
    console.log(`PASS: ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({
      name,
      status: 'FAILED',
      error: error.message,
      details: error.response?.data || error.stack,
    });
    console.log(`FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    if (error.response?.data) {
      console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
  }
}

function markSkipped(name, reason) {
  results.skipped++;
  results.tests.push({ name, status: 'SKIPPED', reason });
  console.log(`SKIP: ${name} (${reason})`);
}

async function postAndAssert(namePrefix, endpoint, body) {
  const url = `${BASE_URL}${API_PREFIX}/staah/${endpoint}`;
  try {
    const response = await axios.post(url, body);
    saveToFile(namePrefix, { url, method: 'POST', body }, response);
    return response;
  } catch (error) {
    saveToFile(namePrefix, { url, method: 'POST', body }, null, error);
    throw error;
  }
}

async function postExpectHttpError(namePrefix, endpoint, body, expectedStatus) {
  const url = `${BASE_URL}${API_PREFIX}/staah/${endpoint}`;
  try {
    await axios.post(url, body);
    throw new Error(`Should have thrown ${expectedStatus} error`);
  } catch (error) {
    if (error.response?.status === expectedStatus) {
      saveToFile(namePrefix, { url, method: 'POST', body }, null, error);
      return error.response;
    }
    throw error;
  }
}

async function testInvalidAuth() {
  const body = {
    apikey: 'wrong-key',
    propertyid: PROPERTY_ID,
    action: 'property_info',
    version: '2',
  };
  const url = `${BASE_URL}${API_PREFIX}/staah/productInfo`;
  try {
    await axios.post(url, body);
    throw new Error('Should have thrown 401 error');
  } catch (error) {
    if (error.response?.status === 401) {
      saveToFile('staah-1-invalid-auth', { url, method: 'POST', body }, null, error);
      return;
    }
    throw error;
  }
}

async function testMissingAuth() {
  const body = {
    propertyid: PROPERTY_ID,
    action: 'property_info',
    version: '2',
  };
  const url = `${BASE_URL}${API_PREFIX}/staah/productInfo`;
  try {
    await axios.post(url, body);
    throw new Error('Should have thrown 401 error');
  } catch (error) {
    if (error.response?.status === 401) {
      saveToFile('staah-2-missing-auth', { url, method: 'POST', body }, null, error);
      return;
    }
    throw error;
  }
}

async function testInvalidPropertyId() {
  const body = {
    apikey: API_KEY,
    propertyid: 'INVALID_PROPERTY',
    action: 'property_info',
    version: '2',
  };
  const response = await postAndAssert('staah-3-invalid-property-id', 'productInfo', body);

  if (response.data.status !== 'fail') {
    throw new Error(`Expected status=fail, got ${response.data.status}`);
  }
}

async function testProductInfo() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'property_info',
    version: '2',
  };
  const response = await postAndAssert('staah-4-product-info', 'productInfo', body);

  if (REQUIRE_VALID_PROPERTY) {
    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }
    if (!response.data.propertyname) {
      throw new Error('Expected propertyname in productInfo response');
    }
    return;
  }

  if (!['success', 'fail'].includes(response.data.status)) {
    throw new Error(`Unexpected status value: ${response.data.status}`);
  }
}

async function testProductInfoWrongAction() {
  await postExpectHttpError('staah-15-product-info-wrong-action', 'productInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'wrong_action',
    version: '2',
  }, 400);
}

async function testProductInfoWrongVersion() {
  await postExpectHttpError('staah-16-product-info-wrong-version', 'productInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'property_info',
    version: '3',
  }, 400);
}

async function testRatePlanInfo() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'roomrate_info',
    version: '2',
  };
  const response = await postAndAssert('staah-5-rate-plan-info', 'ratePlanInfo', body);

  if (REQUIRE_VALID_PROPERTY) {
    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }
    if (!Array.isArray(response.data.rateplans)) {
      throw new Error('Expected rateplans array in ratePlanInfo response');
    }
    return;
  }

  if (!['success', 'fail'].includes(response.data.status)) {
    throw new Error(`Unexpected status value: ${response.data.status}`);
  }
}

async function testRatePlanInfoWrongAction() {
  await postExpectHttpError('staah-17-rate-plan-info-wrong-action', 'ratePlanInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'wrong_action',
    version: '2',
  }, 400);
}

async function testRatePlanInfoWrongVersion() {
  await postExpectHttpError('staah-18-rate-plan-info-wrong-version', 'ratePlanInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'roomrate_info',
    version: '1',
  }, 400);
}

async function testInventoryUpdate() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    version: '2',
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    data: [
      { start_date: '2026-10-01', end_date: '2026-10-03', free: 8 },
      { start_date: '2026-10-04', end_date: '2026-10-06', free: 5 },
    ],
  };
  const response = await postAndAssert('staah-6-inventory-update', 'inventoryUpdate', body);

  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(response.data.status)) {
      throw new Error(`Unexpected status value: ${response.data.status}`);
    }
  } else if (response.data.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${response.data.status}`);
  }
}

async function testRateUpdate() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    version: '2',
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    data: [
      {
        start_date: '2026-10-01',
        end_date: '2026-10-03',
        SINGLE: 4200,
        DOUBLE: 5200,
        TRIPLE: 6200,
      },
    ],
  };
  const response = await postAndAssert('staah-7-rate-update', 'rateUpdate', body);

  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(response.data.status)) {
      throw new Error(`Unexpected status value: ${response.data.status}`);
    }
  } else if (response.data.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${response.data.status}`);
  }
}

async function testRestrictionUpdate() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    version: '2',
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    data: [
      {
        start_date: '2026-11-01',
        end_date: '2026-11-05',
        type: 'Status',
        value: 'Open',
      },
    ],
  };
  const response = await postAndAssert('staah-8-restriction-update', 'restrictionUpdate', body);

  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(response.data.status)) {
      throw new Error(`Unexpected status value: ${response.data.status}`);
    }
  } else if (response.data.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${response.data.status}`);
  }
}

async function testReservation() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'reservation_info',
    version: '2',
    reservations: {
      reservation: [
        {
          bookingId: `STAAH-RES-${Date.now()}`,
          room_id: ROOM_ID,
          rate_id: RATEPLAN_ID,
          checkIn: '2026-12-01',
          checkOut: '2026-12-03',
        },
      ],
    },
    trackingId: `TRK-${Date.now()}`,
  };
  const response = await postAndAssert('staah-9-reservation', 'reservation', body);

  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new Error('Expected reservation response as array');
  }
  const first = response.data[0] || {};
  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(first.status)) {
      throw new Error(`Unexpected status value: ${first.status}`);
    }
  } else if (first.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${first.status}`);
  }
}

async function testReservationWrongAction() {
  await postExpectHttpError('staah-19-reservation-wrong-action', 'reservation', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'wrong_action',
    version: '2',
    reservations: {
      reservation: [],
    },
  }, 400);
}

async function testReservationWrongVersion() {
  await postExpectHttpError('staah-20-reservation-wrong-version', 'reservation', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'reservation_info',
    version: '1',
    reservations: {
      reservation: [],
    },
  }, 400);
}

async function testReservationMissingReservations() {
  await postExpectHttpError('staah-21-reservation-missing-reservations', 'reservation', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'reservation_info',
    version: '2',
  }, 400);
}

async function testReservationMissingReservationArray() {
  await postExpectHttpError('staah-22-reservation-missing-array', 'reservation', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    action: 'reservation_info',
    version: '2',
    reservations: {},
  }, 400);
}

async function testModifyReservation() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    version: '2',
    reservationId: `STAAH-RES-${Date.now()}`,
    data: {
      status: 'modified',
      note: 'Test modify payload',
    },
    trackingId: `TRK-MOD-${Date.now()}`,
  };
  const response = await postAndAssert('staah-10-modify-reservation', 'modifyReservation', body);

  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(response.data.status)) {
      throw new Error(`Unexpected status value: ${response.data.status}`);
    }
  } else if (response.data.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${response.data.status}`);
  }
}

async function testCancelReservation() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    version: '2',
    reservationId: `STAAH-RES-${Date.now()}`,
    data: {
      status: 'cancelled',
      reason: 'Test cancellation payload',
    },
    trackingId: `TRK-CAN-${Date.now()}`,
  };
  const response = await postAndAssert('staah-11-cancel-reservation', 'cancelReservation', body);

  const expected = REQUIRE_VALID_PROPERTY ? 'success' : ['success', 'fail'];
  if (Array.isArray(expected)) {
    if (!expected.includes(response.data.status)) {
      throw new Error(`Unexpected status value: ${response.data.status}`);
    }
  } else if (response.data.status !== expected) {
    throw new Error(`Expected status=${expected}, got ${response.data.status}`);
  }
}

/**
 * ARR_info — ARI date-range pull (adapter endpoint; request body is exact STAAH v2 doc contract)
 * Route: POST /api/v1/staah/arrInfo
 */
async function testArrInfo() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: '2026-10-01',
    to_date: '2026-10-31',
    version: '2',
  };
  const response = await postAndAssert('staah-12-arr-info', 'arrInfo', body);

  if (!['success', 'fail'].includes(response.data.status)) {
    throw new Error(`Unexpected status value: ${response.data.status}`);
  }
  if (response.data.trackingId === undefined || response.data.trackingId === null) {
    throw new Error('Expected trackingId in arrInfo response');
  }
}

/**
 * year_info_ARR — ARI full-year pull (adapter endpoint; request body is exact STAAH v2 doc contract)
 * Route: POST /api/v1/staah/yearInfoArr
 */
async function testYearInfoArr() {
  const body = {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'year_info_ARR',
    version: '2',
  };
  const response = await postAndAssert('staah-13-year-info-arr', 'yearInfoArr', body);

  if (!['success', 'fail'].includes(response.data.status)) {
    throw new Error(`Unexpected status value: ${response.data.status}`);
  }
  if (response.data.trackingId === undefined || response.data.trackingId === null) {
    throw new Error('Expected trackingId in yearInfoArr response');
  }
}

async function testArrInfoWrongAction() {
  await postExpectHttpError('staah-14-arr-info-wrong-action', 'arrInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'wrong_action',
    from_date: '2026-10-01',
    to_date: '2026-10-31',
    version: '2',
  }, 400);
}

async function testYearInfoArrWrongAction() {
  await postExpectHttpError('staah-23-year-info-arr-wrong-action', 'yearInfoArr', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'wrong_action',
    version: '2',
  }, 400);
}

async function testArrInfoWrongVersion() {
  await postExpectHttpError('staah-24-arr-info-wrong-version', 'arrInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: '2026-10-01',
    to_date: '2026-10-31',
    version: '1',
  }, 400);
}

async function testYearInfoArrWrongVersion() {
  await postExpectHttpError('staah-25-year-info-arr-wrong-version', 'yearInfoArr', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'year_info_ARR',
    version: '1',
  }, 400);
}

async function testArrInfoInvalidFromDate() {
  await postExpectHttpError('staah-26-arr-info-invalid-from-date', 'arrInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: 'bad-date',
    to_date: '2026-10-31',
    version: '2',
  }, 400);
}

async function testArrInfoInvalidToDate() {
  await postExpectHttpError('staah-27-arr-info-invalid-to-date', 'arrInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: '2026-10-01',
    to_date: 'bad-date',
    version: '2',
  }, 400);
}

async function testArrInfoInvalidDateRange() {
  await postExpectHttpError('staah-28-arr-info-invalid-date-range', 'arrInfo', {
    apikey: API_KEY,
    propertyid: PROPERTY_ID,
    room_id: ROOM_ID,
    rate_id: RATEPLAN_ID,
    action: 'ARR_info',
    from_date: '2026-10-31',
    to_date: '2026-10-01',
    version: '2',
  }, 400);
}

async function checkServer() {
  try {
    console.log('Checking if server is running...');
    await axios.post(`${BASE_URL}${API_PREFIX}/staah/productInfo`, {}, {
      timeout: 3000,
      validateStatus: () => true,
    });
    console.log('Server is reachable\n');
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      console.error('Server is not running');
      console.error(`Please start the server with: npm run start:dev`);
      console.error(`Expected server at: ${BASE_URL}`);
      process.exit(1);
    }
    console.log('Server is reachable\n');
    return true;
  }
}

async function runAllTests() {
  console.log('============================================================');
  console.log('STAAH CM-OTA API Test Suite');
  console.log('============================================================');
  console.log(`Base URL: ${BASE_URL}${API_PREFIX}/staah`);
  console.log(`Property strict mode: ${REQUIRE_VALID_PROPERTY ? 'ON' : 'OFF'}`);

  console.log('\nAUTHENTICATION TESTS');
  await runTest('Invalid API Key', testInvalidAuth);
  await runTest('Missing Auth Credentials', testMissingAuth);

  console.log('\nVALIDATION TESTS');
  await runTest('Invalid PropertyId', testInvalidPropertyId);
  await runTest('Product Info Wrong Action Rejected', testProductInfoWrongAction);
  await runTest('Product Info Wrong Version Rejected', testProductInfoWrongVersion);
  await runTest('Rate Plan Info Wrong Action Rejected', testRatePlanInfoWrongAction);
  await runTest('Rate Plan Info Wrong Version Rejected', testRatePlanInfoWrongVersion);
  await runTest('Reservation Wrong Action Rejected', testReservationWrongAction);
  await runTest('Reservation Wrong Version Rejected', testReservationWrongVersion);
  await runTest('Reservation Missing Wrapper Rejected', testReservationMissingReservations);
  await runTest('Reservation Missing Array Rejected', testReservationMissingReservationArray);

  console.log('\nFUNCTIONAL ENDPOINT TESTS');
  await runTest('Product Info', testProductInfo);
  await runTest('Rate Plan Info', testRatePlanInfo);
  await runTest('Inventory Update', testInventoryUpdate);
  await runTest('Rate Update', testRateUpdate);
  await runTest('Restriction Update', testRestrictionUpdate);
  await runTest('Reservation', testReservation);
  await runTest('Modify Reservation', testModifyReservation);
  await runTest('Cancel Reservation', testCancelReservation);

  console.log('\nARI PULL ENDPOINT TESTS (adapter; request body = exact STAAH v2 doc contract)');
  await runTest('ARR Info (Date-Range Pull)', testArrInfo);
  await runTest('Year Info ARR (Full-Year Pull)', testYearInfoArr);
  await runTest('ARR Info Wrong Action Rejected', testArrInfoWrongAction);
  await runTest('Year Info ARR Wrong Action Rejected', testYearInfoArrWrongAction);
  await runTest('ARR Info Wrong Version Rejected', testArrInfoWrongVersion);
  await runTest('Year Info ARR Wrong Version Rejected', testYearInfoArrWrongVersion);
  await runTest('ARR Info Invalid from_date Rejected', testArrInfoInvalidFromDate);
  await runTest('ARR Info Invalid to_date Rejected', testArrInfoInvalidToDate);
  await runTest('ARR Info Invalid Date Range Rejected', testArrInfoInvalidDateRange);

  console.log('\n============================================================');
  console.log('TEST SUMMARY');
  console.log('============================================================');
  console.log(`Passed:  ${results.passed}`);
  console.log(`Failed:  ${results.failed}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Total:   ${results.passed + results.failed + results.skipped}`);

  if (results.failed > 0) {
    console.log('\nFAILED TESTS:');
    results.tests
      .filter((test) => test.status === 'FAILED')
      .forEach((test) => {
        console.log(`- ${test.name}: ${test.error}`);
      });
    process.exit(1);
  }

  console.log('\nAll tests passed');
  process.exit(0);
}

(async () => {
  await checkServer();

  if (!API_KEY || API_KEY === 'test-key-12345') {
    markSkipped('All functional tests', 'STAAH_API_KEY is not set in environment');
    console.log('Set STAAH_API_KEY in .env, then rerun: node test/staah-api.test.js');
    process.exit(0);
  }

  const TARGET_IS_PRODUCTION = /^https?:\/\/(www\.)?dvi\.travel/i.test(BASE_URL);
  if (TARGET_IS_PRODUCTION && API_KEY === 'staah-local-test-key') {
    console.error('Refusing to run STAAH tests on production URL with local test key.');
    console.error('Set STAAH_API_KEY to the real production key in .env before testing dvi.travel.');
    process.exit(1);
  }

  console.log(`Using STAAH_API_KEY: ${API_KEY ? '***set***' : '(empty)'}`);

  await runAllTests();
})();
