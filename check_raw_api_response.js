const http = require('http');

const options = {
  hostname: '127.0.0.1',
  port: 4006,
  path: '/api/v1/itineraries/details/DVI20260589',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3Nzk1NTA0MjgsImV4cCI6MTc4MDE1NTIyOH0.JpLZDctwv_ByjQz0owKkPH_bpqILp7fSQbqNhjHJdU4'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const day3 = json.days[2];
      
      // Find Mullakkal temple in Day 3
      const temple = day3.segments.find(s => 
        s.type === 'attraction' && 
        s.name && s.name.toLowerCase().includes('mullakkal')
      );
      
      if (temple) {
        console.log('=== RAW API RESPONSE ===');
        console.log('Name:', temple.name);
        console.log('Visit Time:', temple.visitTime);
        console.log('Full segment:', JSON.stringify(temple, null, 2));
      }
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});

req.on('error', (error) => {
  console.error(error);
});

req.end();
