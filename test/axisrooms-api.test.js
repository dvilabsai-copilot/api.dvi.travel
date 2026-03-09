// AxisRooms API Test Suite
// Run with: node test/axisrooms-api.test.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const BASE_URL = process.env.BASE_URL || 'https://dvi.travel';
const API_PREFIX = process.env.API_PREFIX || '/api/V1';
const API_KEY = process.env.AXISROOMS_API_KEY || 'test-key-12345';
const PROPERTY_ID = process.env.AXISROOMS_PROPERTY_ID || 'AX_TEST_1';
const ROOM_ID = process.env.AXISROOMS_ROOM_ID || 'DELUXE_ROOM';
const RATEPLAN_ID = process.env.AXISROOMS_RATEPLAN_ID || 'CP_PLAN';
const LOG_OUTPUT_DIR = process.env.LOG_OUTPUT_DIR || '';
const LOG_DIR_PATH = LOG_OUTPUT_DIR
  ? path.resolve(__dirname, LOG_OUTPUT_DIR)
  : __dirname;

if (!fs.existsSync(LOG_DIR_PATH)) {
  fs.mkdirSync(LOG_DIR_PATH, { recursive: true });
}

// Test results tracker
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

// Helper function to save request/response to file
function saveToFile(filename, requestData, responseData, error = null) {
  const timestamp = new Date().toISOString();
  const sanitizedFilename = filename.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.txt';
  const filePath = path.join(LOG_DIR_PATH, sanitizedFilename);
  
  let content = `============================================================\n`;
  content += `AxisRooms API Test Log\n`;
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
  console.log(`   📝 Saved to: ${path.relative(__dirname, filePath)}`);
}

// Helper function to run a test
async function runTest(name, testFn) {
  try {
    console.log(`\n🧪 Running: ${name}`);
    await testFn();
    results.passed++;
    results.tests.push({ name, status: 'PASSED' });
    console.log(`✅ PASSED: ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ 
      name, 
      status: 'FAILED', 
      error: error.message,
      details: error.response?.data || error.stack
    });
    console.log(`❌ FAILED: ${name}`);
    console.log(`   Error: ${error.message}`);
    if (error.response?.data) {
      console.log(`   Response:`, JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Test 1: Product Info - Valid Request
async function testProductInfo() {
  const requestBody = {
    auth: { key: API_KEY },
    propertyId: PROPERTY_ID
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('1-product-info', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }

    console.log(`   Found ${response.data.data.length} rooms`);
    console.log(`   Rooms:`, response.data.data.map(r => r.name).join(', '));
  } catch (error) {
    saveToFile('1-product-info', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 2: Rate Plan Info - Valid Request
async function testRatePlanInfo() {
  const requestBody = {
    auth: { key: API_KEY },
    propertyId: PROPERTY_ID,
    roomId: ROOM_ID
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/ratePlanInfo`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('2-rate-plan-info', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }

    console.log(`   Found ${response.data.data.length} rate plans`);
  } catch (error) {
    saveToFile('2-rate-plan-info', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 3: Inventory Update - Valid Request
async function testInventoryUpdate() {
  const requestBody = {
    auth: { key: API_KEY },
    data: {
      propertyId: PROPERTY_ID,
      roomId: ROOM_ID,
      inventory: [
        { startDate: '2026-06-01', endDate: '2026-06-05', free: 10 },
        { startDate: '2026-06-06', endDate: '2026-06-10', free: 5 }
      ]
    }
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/inventoryUpdate`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('3-inventory-update', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Inventory updated successfully`);
  } catch (error) {
    saveToFile('3-inventory-update', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 4: Rate Update - Valid Request with Dynamic Occupancy
async function testRateUpdate() {
  const requestBody = {
    auth: { key: API_KEY },
    data: {
      propertyId: PROPERTY_ID,
      roomId: ROOM_ID,
      rateplanId: RATEPLAN_ID,
      rate: [
        {
          startDate: '2026-06-01',
          endDate: '2026-06-05',
          SINGLE: 5000,
          DOUBLE: 6000,
          TRIPLE: 7000,
          EXTRABED: 1000
        },
        {
          startDate: '2026-06-06',
          endDate: '2026-06-10',
          SINGLE: 5500,
          DOUBLE: 6500
        }
      ]
    }
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/rateUpdate`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('4-rate-update', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Rates updated successfully`);
  } catch (error) {
    saveToFile('4-rate-update', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 5: Restriction Update - Status Type
async function testRestrictionUpdateStatus() {
  const requestBody = {
    auth: { key: API_KEY },
    data: [
      {
        propertyId: PROPERTY_ID,
        roomDetails: [
          {
            roomId: ROOM_ID,
            ratePlanDetails: [
              {
                ratePlanId: RATEPLAN_ID,
                restrictions: {
                  periods: [
                    { startDate: '2026-06-01', endDate: '2026-06-05' },
                    { startDate: '2026-06-10', endDate: '2026-06-15' }
                  ],
                  type: 'Status',
                  value: 'Open'
                }
              }
            ]
          }
        ]
      }
    ]
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('5-restriction-update-status', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Status restrictions updated successfully`);
  } catch (error) {
    saveToFile('5-restriction-update-status', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 6: Restriction Update - COA Type
async function testRestrictionUpdateCOA() {
  const requestBody = {
    auth: { key: API_KEY },
    data: [
      {
        propertyId: PROPERTY_ID,
        roomDetails: [
          {
            roomId: ROOM_ID,
            ratePlanDetails: [
              {
                ratePlanId: RATEPLAN_ID,
                restrictions: {
                  periods: [{ startDate: '2026-07-01', endDate: '2026-07-31' }],
                  type: 'COA',
                  value: 'Close'
                }
              }
            ]
          }
        ]
      }
    ]
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('6-restriction-update-coa', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   COA restrictions updated successfully`);
  } catch (error) {
    saveToFile('6-restriction-update-coa', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 7: Restriction Update - MLos Type
async function testRestrictionUpdateMLos() {
  const requestBody = {
    auth: { key: API_KEY },
    data: [
      {
        propertyId: PROPERTY_ID,
        roomDetails: [
          {
            roomId: ROOM_ID,
            ratePlanDetails: [
              {
                ratePlanId: RATEPLAN_ID,
                restrictions: {
                  periods: [{ startDate: '2026-08-01', endDate: '2026-08-31' }],
                  type: 'MLos',
                  value: '3'
                }
              }
            ]
          }
        ]
      }
    ]
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/restrictionUpdate`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('7-restriction-update-mlos', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   MLos restrictions updated successfully`);
  } catch (error) {
    saveToFile('7-restriction-update-mlos', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 8: Invalid Auth - Should Return 401
async function testInvalidAuth() {
  const requestBody = {
    auth: { key: 'wrong-key' },
    propertyId: PROPERTY_ID
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`;
  
  try {
    await axios.post(url, requestBody);
    throw new Error('Should have thrown 401 error');
  } catch (error) {
    if (error.response?.status === 401) {
      saveToFile('8-invalid-auth', {
        url,
        method: 'POST',
        body: requestBody
      }, null, error);
      console.log(`   Correctly returned 401 Unauthorized`);
      return;
    }
    throw error;
  }
}

// Test 9: Invalid Property ID - Should Return Failure
async function testInvalidPropertyId() {
  const requestBody = {
    auth: { key: API_KEY },
    propertyId: 'INVALID_PROPERTY'
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`;
  
  try {
    const response = await axios.post(url, requestBody);
    
    saveToFile('9-invalid-property-id', {
      url,
      method: 'POST',
      body: requestBody
    }, response);

    if (response.data.status !== 'failure') {
      throw new Error(`Expected status=failure, got ${response.data.status}`);
    }

    console.log(`   Correctly returned failure for invalid propertyId`);
  } catch (error) {
    saveToFile('9-invalid-property-id', {
      url,
      method: 'POST',
      body: requestBody
    }, null, error);
    throw error;
  }
}

// Test 10: Missing Auth - Should Return 401
async function testMissingAuth() {
  const requestBody = {
    propertyId: PROPERTY_ID
  };
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`;
  
  try {
    await axios.post(url, requestBody);
    throw new Error('Should have thrown 401 error');
  } catch (error) {
    if (error.response?.status === 401) {
      saveToFile('10-missing-auth', {
        url,
        method: 'POST',
        body: requestBody
      }, null, error);
      console.log(`   Correctly returned 401 for missing auth`);
      return;
    }
    throw error;
  }
}

// Main test runner
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       AxisRooms CM-OTA API Test Suite                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\n📍 Base URL: ${BASE_URL}${API_PREFIX}/axisrooms`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`🏨 Test Property: ${PROPERTY_ID}\n`);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('AUTHENTICATION TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  await runTest('Invalid API Key', testInvalidAuth);
  await runTest('Missing Auth Credentials', testMissingAuth);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('VALIDATION TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  await runTest('Invalid PropertyId', testInvalidPropertyId);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('FUNCTIONAL TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  await runTest('Product Info - Get Rooms', testProductInfo);
  await runTest('Rate Plan Info - Get Rate Plans', testRatePlanInfo);
  await runTest('Inventory Update', testInventoryUpdate);
  await runTest('Rate Update with Dynamic Occupancy', testRateUpdate);
  await runTest('Restriction Update - Status Type', testRestrictionUpdateStatus);
  await runTest('Restriction Update - COA Type', testRestrictionUpdateCOA);
  await runTest('Restriction Update - MLos Type', testRestrictionUpdateMLos);

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📊 Total:  ${results.passed + results.failed}`);
  
  if (results.failed > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.tests
      .filter(t => t.status === 'FAILED')
      .forEach(t => {
        console.log(`\n  ❌ ${t.name}`);
        console.log(`     Error: ${t.error}`);
        if (t.details) {
          console.log(`     Details:`, JSON.stringify(t.details, null, 6));
        }
      });
    process.exit(1);
  } else {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  }
}

// Check if server is running
async function checkServer() {
  try {
    console.log('🔍 Checking if server is running...');
    // Test with a simple invalid request to AxisRooms endpoint
    await axios.post(`${BASE_URL}${API_PREFIX}/axisrooms/productInfo`, {}, {
      timeout: 3000,
      validateStatus: () => true // Accept any status (expecting 401)
    });
    console.log('✅ Server is running\n');
    return true;
  } catch (error) {
    // If we get a connection error (not HTTP error), server is down
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      console.error('❌ Server is not running!');
      console.error(`   Please start the server with: npm run start:dev`);
      console.error(`   Expected server at: ${BASE_URL}\n`);
      process.exit(1);
    }
    // If we get any HTTP response (even error), server is up
    console.log('✅ Server is running\n');
    return true;
  }
}

// Run tests
(async () => {
  await checkServer();
  await runAllTests();
})();
