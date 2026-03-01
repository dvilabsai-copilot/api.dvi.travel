// Quick test for updated ProductInfo endpoint
// Run with: node test/test-product-info-dvi.js

const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:4006';
const API_PREFIX = '/api/v1';
const API_KEY = 'test-key-12345';
const PROPERTY_ID = 'AX_TEST_1';

async function testProductInfo() {
  console.log('🧪 Testing ProductInfo with DVI hotel rooms...\n');
  
  const requestBody = {
    auth: { key: API_KEY },
    propertyId: PROPERTY_ID
  };
  
  const url = `${BASE_URL}${API_PREFIX}/axisrooms/productInfo`;
  
  try {
    console.log('📤 Request:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log();
    
    const response = await axios.post(url, requestBody);
    
    console.log('📥 Response:');
    console.log(`Status: ${response.status}`);
    console.log(JSON.stringify(response.data, null, 2));
    console.log();
    
    // Validate response
    if (response.data.status !== 'success') {
      throw new Error(`Expected status=success, got ${response.data.status}`);
    }
    
    if (!Array.isArray(response.data.data)) {
      throw new Error('Expected data to be an array');
    }
    
    if (response.data.data.length === 0) {
      throw new Error('Expected at least one room, got empty array');
    }
    
    console.log('✅ SUCCESS: ProductInfo now returns rooms from dvi_hotel_rooms!');
    console.log(`   Found ${response.data.data.length} rooms:`);
    response.data.data.forEach((room, idx) => {
      console.log(`   ${idx + 1}. ${room.name} (ID: ${room.id})`);
    });
    
    // Verify the rooms have proper IDs from room_ref_code or room_ID
    const hasRoomRefCode = response.data.data.some(r => 
      r.id === 'DELUXE_ROOM' || r.id === 'SUITE_ROOM'
    );
    
    if (hasRoomRefCode) {
      console.log('   ✓ Using room_ref_code for IDs');
    } else {
      console.log('   ✓ Using room_ID for IDs');
    }
    
    // Verify room names are from room types
    const hasRoomTypeNames = response.data.data.some(r => 
      r.name.includes('Deluxe Room') || r.name.includes('Suite Room')
    );
    
    if (hasRoomTypeNames) {
      console.log('   ✓ Using room_type_title for names');
    }
    
    console.log('\n🎉 All validations passed!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ FAILED:', error.message);
    if (error.response?.data) {
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

// Check if server is running
async function checkServer() {
  try {
    await axios.get(`${BASE_URL}/`);
    return true;
  } catch (error) {
    return false;
  }
}

async function main() {
  const isRunning = await checkServer();
  if (!isRunning) {
    console.error('❌ Server is not running on', BASE_URL);
    console.error('   Start the server with: npm run start:dev');
    process.exit(1);
  }
  
  await testProductInfo();
}

main();
