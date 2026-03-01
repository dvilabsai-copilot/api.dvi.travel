const axios = require('axios');

console.log('Testing connection to http://localhost:4006');

axios.post('http://localhost:4006/api/v1/axisrooms/productInfo', {
  auth: { key: 'test-key-12345' },
  propertyId: 'AX_TEST_1'
}, {
  timeout: 5000
})
.then(response => {
  console.log('Success! Status:', response.status);
  console.log('Data:', JSON.stringify(response.data, null, 2));
})
.catch(error => {
  console.log('Error type:', error.code || 'HTTP_ERROR');
  console.log('Error message:', error.message);
  if (error.response) {
    console.log('Response status:', error.response.status);
    console.log('Response data:', JSON.stringify(error.response.data, null, 2));
  }
});
