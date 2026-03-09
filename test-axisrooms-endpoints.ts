// FILE: test-axisrooms-endpoints.ts
// Comprehensive test script for AxisRooms endpoints
// Usage: npx ts-node test-axisrooms-endpoints.ts

import axios, { AxiosError } from 'axios';

// Configuration
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_PREFIX = '/api/v1';
const API_KEY = process.env.AXISROOMS_API_KEY || 'test-key-12345';

const TEST_PROPERTY_ID = 'AX_TEST_HOTEL_1';
const TEST_ROOM_ID = 'DELUXE_ROOM';
const TEST_RATEPLAN_ID = 'CP_PLAN';

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  response?: any;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  testFn: () => Promise<void>,
): Promise<void> {
  try {
    await testFn();
    results.push({ name, passed: true, message: 'Passed' });
    console.log(`✅ ${name}`);
  } catch (error: any) {
    results.push({
      name,
      passed: false,
      message: error.message,
      response: error.response?.data,
    });
    console.log(`❌ ${name}: ${error.message}`);
  }
}

async function testInvalidAuth() {
  await runTest('Invalid Auth Key - Should Return 401', async () => {
    try {
      await axios.post(`${BASE_URL}${API_PREFIX}/axisrooms/productInfo`, {
        auth: { key: 'wrong-key' },
        propertyId: TEST_PROPERTY_ID,
      });
      throw new Error('Should have thrown 401');
    } catch (error: any) {
      if (error.response?.status === 401 && error.response?.data?.status === 'failure') {
        return;
      }
      throw error;
    }
  });
}

async function testMissingAuth() {
  await runTest('Missing Auth - Should Return 401', async () => {
    try {
      await axios.post(`${BASE_URL}${API_PREFIX}/axisrooms/productInfo`, {
        propertyId: TEST_PROPERTY_ID,
      });
      throw new Error('Should have thrown 401');
    } catch (error: any) {
      if (error.response?.status === 401) {
        return;
      }
      throw error;
    }
  });
}

async function testInvalidPropertyId() {
  await runTest('Invalid Property ID - Should Return Failure', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`,
      {
        auth: { key: API_KEY },
        propertyId: 'INVALID_PROPERTY',
      },
    );

    if (response.data.status !== 'failure') {
      throw new Error(`Expected status=failure, got ${response.data.status}`);
    }
  });
}

async function testProductInfo() {
  await runTest('ProductInfo - Valid Request', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`,
      {
        auth: { key: API_KEY },
        propertyId: TEST_PROPERTY_ID,
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }

    console.log(`   Found ${response.data.data.length} rooms`);
  });
}

async function testRatePlanInfo() {
  await runTest('RatePlanInfo - Valid Request', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/ratePlanInfo`,
      {
        auth: { key: API_KEY },
        propertyId: TEST_PROPERTY_ID,
        roomId: TEST_ROOM_ID,
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }

    console.log(`   Found ${response.data.data.length} rate plans`);
  });
}

async function testInventoryUpdate() {
  await runTest('InventoryUpdate - Valid Request', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/inventoryUpdate`,
      {
        auth: { key: API_KEY },
        data: {
          propertyId: TEST_PROPERTY_ID,
          roomId: TEST_ROOM_ID,
          inventory: [
            { startDate: '2026-06-01', endDate: '2026-06-05', free: 10 },
            { startDate: '2026-06-06', endDate: '2026-06-10', free: 5 },
          ],
        },
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log('   Inventory updated successfully');
  });
}

async function testRateUpdate() {
  await runTest('RateUpdate - Valid Request with Dynamic Occupancy', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/rateUpdate`,
      {
        auth: { key: API_KEY },
        data: {
          propertyId: TEST_PROPERTY_ID,
          roomId: TEST_ROOM_ID,
          rateplanId: TEST_RATEPLAN_ID,
          rate: [
            {
              startDate: '2026-06-01',
              endDate: '2026-06-05',
              SINGLE: 5000,
              DOUBLE: 6000,
              TRIPLE: 7000,
              EXTRABED: 1000,
            },
            {
              startDate: '2026-06-06',
              endDate: '2026-06-10',
              SINGLE: 5500,
              DOUBLE: 6500,
            },
          ],
        },
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log('   Rates updated successfully');
  });
}

async function testRestrictionUpdate() {
  await runTest('RestrictionUpdate - Valid Request', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`,
      {
        auth: { key: API_KEY },
        data: [
          {
            propertyId: TEST_PROPERTY_ID,
            roomDetails: [
              {
                roomId: TEST_ROOM_ID,
                ratePlanDetails: [
                  {
                    ratePlanId: TEST_RATEPLAN_ID,
                    restrictions: {
                      periods: [
                        { startDate: '2026-06-01', endDate: '2026-06-05' },
                        { startDate: '2026-06-10', endDate: '2026-06-15' },
                      ],
                      type: 'Status',
                      value: 'Open',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log('   Restrictions updated successfully');
  });
}

async function testRestrictionTypeCOA() {
  await runTest('RestrictionUpdate - COA Type', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`,
      {
        auth: { key: API_KEY },
        data: [
          {
            propertyId: TEST_PROPERTY_ID,
            roomDetails: [
              {
                roomId: TEST_ROOM_ID,
                ratePlanDetails: [
                  {
                    ratePlanId: TEST_RATEPLAN_ID,
                    restrictions: {
                      periods: [{ startDate: '2026-07-01', endDate: '2026-07-31' }],
                      type: 'COA',
                      value: 'Close',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log('   COA restriction updated successfully');
  });
}

async function testRestrictionTypeMLos() {
  await runTest('RestrictionUpdate - MLos Type', async () => {
    const response = await axios.post(
      `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`,
      {
        auth: { key: API_KEY },
        data: [
          {
            propertyId: TEST_PROPERTY_ID,
            roomDetails: [
              {
                roomId: TEST_ROOM_ID,
                ratePlanDetails: [
                  {
                    ratePlanId: TEST_RATEPLAN_ID,
                    restrictions: {
                      periods: [{ startDate: '2026-08-01', endDate: '2026-08-31' }],
                      type: 'MLos',
                      value: '3',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log('   MLos restriction updated successfully');
  });
}

async function main() {
  console.log('🧪 AxisRooms Endpoints Test Suite');
  console.log('==================================\n');
  console.log(`Base URL: ${BASE_URL}${API_PREFIX}/axisrooms`);
  console.log(`API Key: ${API_KEY.substring(0, 8)}...`);
  console.log(`Test Property: ${TEST_PROPERTY_ID}\n`);

  // Run authentication tests
  console.log('📋 Authentication Tests:');
  await testInvalidAuth();
  await testMissingAuth();

  // Run validation tests
  console.log('\n📋 Validation Tests:');
  await testInvalidPropertyId();

  // Run functional tests
  console.log('\n📋 Functional Tests:');
  await testProductInfo();
  await testRatePlanInfo();
  await testInventoryUpdate();
  await testRateUpdate();
  await testRestrictionUpdate();
  await testRestrictionTypeCOA();
  await testRestrictionTypeMLos();

  // Summary
  console.log('\n==================================');
  console.log('📊 Test Summary:');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Total: ${results.length}`);

  if (failed > 0) {
    console.log('\n❌ Failed Tests:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  - ${r.name}: ${r.message}`);
        if (r.response) {
          console.log(`    Response:`, JSON.stringify(r.response, null, 2));
        }
      });
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!');
  }
}

main().catch((error) => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});
