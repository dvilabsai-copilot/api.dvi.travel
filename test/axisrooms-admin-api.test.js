// AxisRooms Admin API Test Suite
// Tests the admin export endpoints created for AxisRooms hotel mappings
// Run with: node test/axisrooms-admin-api.test.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://127.0.0.1:4006';
const API_PREFIX = '/api/v1';
const ADMIN_KEY = process.env.ADMIN_EXPORT_KEY || 'change_this_secure_key';

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
  const filePath = path.join(__dirname, sanitizedFilename);
  
  let content = `============================================================\n`;
  content += `AxisRooms Admin API Test Log\n`;
  content += `============================================================\n`;
  content += `Test Name: ${filename}\n`;
  content += `Timestamp: ${timestamp}\n`;
  content += `Status: ${error ? 'FAILED' : 'SUCCESS'}\n`;
  content += `============================================================\n\n`;
  
  content += `REQUEST:\n`;
  content += `--------\n`;
  content += `URL: ${requestData.url}\n`;
  content += `Method: ${requestData.method || 'GET'}\n`;
  content += `Headers:\n${JSON.stringify(requestData.headers || {}, null, 2)}\n\n`;
  if (requestData.body) {
    content += `Body:\n${JSON.stringify(requestData.body, null, 2)}\n\n`;
  }
  
  content += `RESPONSE:\n`;
  content += `---------\n`;
  if (error) {
    content += `Status: ${error.response?.status || 'N/A'}\n`;
    content += `Error: ${error.message}\n\n`;
    content += `Response Data:\n${JSON.stringify(error.response?.data || {}, null, 2)}\n`;
  } else {
    content += `Status: ${responseData.status}\n`;
    content += `Headers:\n${JSON.stringify(responseData.headers || {}, null, 2)}\n\n`;
    
    // For CSV responses, show raw data
    if (responseData.headers['content-type']?.includes('text/csv')) {
      content += `Data (CSV):\n${responseData.data}\n`;
    } else {
      const dataStr = JSON.stringify(responseData.data, null, 2);
      // Truncate large responses for readability
      if (dataStr.length > 10000) {
        content += `Data (truncated - ${dataStr.length} chars):\n`;
        content += dataStr.substring(0, 10000) + '\n... (truncated)\n';
      } else {
        content += `Data:\n${dataStr}\n`;
      }
    }
  }
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`   📝 Saved to: ${sanitizedFilename}`);
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

// Test 1: Get Hotels (JSON) - Basic Request
async function testGetHotelsBasic() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-1-get-hotels-basic', {
      url,
      method: 'GET',
      headers
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }

    console.log(`   Total: ${response.data.total} hotels`);
    console.log(`   Returned: ${response.data.data.length} hotels`);
    
    if (response.data.data.length > 0) {
      const sample = response.data.data[0];
      console.log(`   Sample hotel:`, sample.hotel_name, '-', sample.propertyId);
    }
  } catch (error) {
    saveToFile('admin-1-get-hotels-basic', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 2: Get Hotels with Pagination
async function testGetHotelsPagination() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels?limit=10&offset=0`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-2-get-hotels-pagination', {
      url,
      method: 'GET',
      headers
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    if (response.data.data.length > 10) {
      throw new Error('Expected max 10 results with limit=10');
    }

    console.log(`   Total: ${response.data.total} hotels`);
    console.log(`   Returned: ${response.data.data.length} hotels (limit=10)`);
  } catch (error) {
    saveToFile('admin-2-get-hotels-pagination', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 3: Get Hotels with Updated After Filter
async function testGetHotelsUpdatedAfter() {
  const updatedAfter = '2026-02-27T00:00:00Z';
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels?updatedAfter=${updatedAfter}&limit=20`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-3-get-hotels-updated-after', {
      url,
      method: 'GET',
      headers
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Total: ${response.data.total} hotels updated after ${updatedAfter}`);
    console.log(`   Returned: ${response.data.data.length} hotels`);
  } catch (error) {
    saveToFile('admin-3-get-hotels-updated-after', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 4: Get Hotels with Include Details
async function testGetHotelsWithDetails() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels?includeDetails=true&limit=5`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-4-get-hotels-with-details', {
      url,
      method: 'GET',
      headers
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Total: ${response.data.total} hotels`);
    console.log(`   Returned: ${response.data.data.length} hotels with details`);
    
    if (response.data.data.length > 0) {
      const sample = response.data.data[0];
      console.log(`   Sample hotel:`, sample.hotel_name);
      console.log(`   Rooms:`, sample.rooms?.length || 0);
      if (sample.rooms && sample.rooms.length > 0) {
        console.log(`   First room:`, sample.rooms[0].room_name);
        console.log(`   Rate plans:`, sample.rooms[0].rateplans?.length || 0);
      }
    }
  } catch (error) {
    saveToFile('admin-4-get-hotels-with-details', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 5: Get Hotels Disabled (enabled=0)
async function testGetHotelsDisabled() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels?enabled=0&limit=10`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-5-get-hotels-disabled', {
      url,
      method: 'GET',
      headers
    }, response);

    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }

    console.log(`   Total disabled hotels: ${response.data.total}`);
    console.log(`   Returned: ${response.data.data.length} hotels`);
  } catch (error) {
    saveToFile('admin-5-get-hotels-disabled', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 6: CSV Export - Basic
async function testExportCSVBasic() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels/export?limit=100`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-6-export-csv-basic', {
      url,
      method: 'GET',
      headers
    }, response);

    if (!response.headers['content-type']?.includes('text/csv')) {
      throw new Error(`Expected content-type text/csv, got ${response.headers['content-type']}`);
    }

    const lines = response.data.split('\n').filter(line => line.trim());
    console.log(`   CSV lines: ${lines.length}`);
    console.log(`   Header: ${lines[0]}`);
    
    if (lines.length > 1) {
      console.log(`   Sample row: ${lines[1]}`);
    }
  } catch (error) {
    saveToFile('admin-6-export-csv-basic', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 7: CSV Export with Filters
async function testExportCSVWithFilters() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels/export?enabled=1&limit=50`;
  const headers = { 'x-admin-key': ADMIN_KEY };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-7-export-csv-with-filters', {
      url,
      method: 'GET',
      headers
    }, response);

    if (!response.headers['content-type']?.includes('text/csv')) {
      throw new Error(`Expected content-type text/csv, got ${response.headers['content-type']}`);
    }

    const lines = response.data.split('\n').filter(line => line.trim());
    console.log(`   CSV lines: ${lines.length}`);
    console.log(`   Enabled hotels exported: ${lines.length - 1}`); // -1 for header
  } catch (error) {
    saveToFile('admin-7-export-csv-with-filters', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 8: Unauthorized Access - Missing Admin Key
async function testUnauthorizedMissingKey() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels`;
  
  try {
    const response = await axios.get(url);
    
    saveToFile('admin-8-unauthorized-missing-key', {
      url,
      method: 'GET',
      headers: {}
    }, response);

    // Should have thrown an error
    throw new Error('Expected 401 Unauthorized, but request succeeded');
  } catch (error) {
    if (error.response && error.response.status === 401) {
      saveToFile('admin-8-unauthorized-missing-key', {
        url,
        method: 'GET',
        headers: {}
      }, null, error);
      
      console.log(`   Correctly returned 401 Unauthorized`);
      console.log(`   Response:`, JSON.stringify(error.response.data));
      
      if (error.response.data.status !== 'failure') {
        throw new Error(`Expected status=failure in error response`);
      }
      return; // Success - we expected this to fail
    }
    
    saveToFile('admin-8-unauthorized-missing-key', {
      url,
      method: 'GET',
      headers: {}
    }, null, error);
    throw error;
  }
}

// Test 9: Unauthorized Access - Invalid Admin Key
async function testUnauthorizedInvalidKey() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels`;
  const headers = { 'x-admin-key': 'invalid-key-12345' };
  
  try {
    const response = await axios.get(url, { headers });
    
    saveToFile('admin-9-unauthorized-invalid-key', {
      url,
      method: 'GET',
      headers
    }, response);

    // Should have thrown an error
    throw new Error('Expected 401 Unauthorized, but request succeeded');
  } catch (error) {
    if (error.response && error.response.status === 401) {
      saveToFile('admin-9-unauthorized-invalid-key', {
        url,
        method: 'GET',
        headers
      }, null, error);
      
      console.log(`   Correctly returned 401 Unauthorized`);
      console.log(`   Response:`, JSON.stringify(error.response.data));
      
      if (error.response.data.status !== 'failure') {
        throw new Error(`Expected status=failure in error response`);
      }
      return; // Success - we expected this to fail
    }
    
    saveToFile('admin-9-unauthorized-invalid-key', {
      url,
      method: 'GET',
      headers
    }, null, error);
    throw error;
  }
}

// Test 10: CSV Export - Unauthorized
async function testCSVExportUnauthorized() {
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/admin/hotels/export`;
  
  try {
    const response = await axios.get(url);
    
    saveToFile('admin-10-csv-export-unauthorized', {
      url,
      method: 'GET',
      headers: {}
    }, response);

    // Should have thrown an error
    throw new Error('Expected 401 Unauthorized, but request succeeded');
  } catch (error) {
    if (error.response && error.response.status === 401) {
      saveToFile('admin-10-csv-export-unauthorized', {
        url,
        method: 'GET',
        headers: {}
      }, null, error);
      
      console.log(`   Correctly returned 401 Unauthorized`);
      return; // Success - we expected this to fail
    }
    
    saveToFile('admin-10-csv-export-unauthorized', {
      url,
      method: 'GET',
      headers: {}
    }, null, error);
    throw error;
  }
}

// Main test runner
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     AxisRooms Admin API Test Suite                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`Base URL: ${BASE_URL}${API_PREFIX}`);
  console.log(`Admin Key: ${ADMIN_KEY.substring(0, 10)}...`);
  console.log('');

  // Run all tests
  await runTest('1. Get Hotels - Basic', testGetHotelsBasic);
  await runTest('2. Get Hotels - Pagination', testGetHotelsPagination);
  await runTest('3. Get Hotels - Updated After Filter', testGetHotelsUpdatedAfter);
  await runTest('4. Get Hotels - With Details', testGetHotelsWithDetails);
  await runTest('5. Get Hotels - Disabled (enabled=0)', testGetHotelsDisabled);
  await runTest('6. CSV Export - Basic', testExportCSVBasic);
  await runTest('7. CSV Export - With Filters', testExportCSVWithFilters);
  await runTest('8. Unauthorized - Missing Key', testUnauthorizedMissingKey);
  await runTest('9. Unauthorized - Invalid Key', testUnauthorizedInvalidKey);
  await runTest('10. CSV Export - Unauthorized', testCSVExportUnauthorized);

  // Print summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                   TEST SUMMARY                        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`📊 Total:  ${results.passed + results.failed}`);

  if (results.failed > 0) {
    console.log('\n❌ Failed tests:');
    results.tests
      .filter(t => t.status === 'FAILED')
      .forEach(t => {
        console.log(`   - ${t.name}: ${t.error}`);
      });
  } else {
    console.log('\n🎉 All tests passed!');
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

// Run the tests
runAllTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
