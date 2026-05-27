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
      const day3 = json.days[2]; // Day 3 (0-indexed)
      console.log('=== DAY 3 ===');
      console.log('Route:', day3.route);
      console.log('\nSegments:');
      day3.segments.forEach((seg, i) => {
        console.log(`\n[${i}] Type: ${seg.type}`);
        if (seg.type === 'attraction') {
          console.log(`    Name: ${seg.name}`);
          console.log(`    Visit Time: ${seg.visitTime}`);
          console.log(`    Priority: ${seg.priority}`);
        } else if (seg.type === 'break') {
          console.log(`    Duration: ${seg.duration}`);
          console.log(`    Time Range: ${seg.timeRange}`);
        } else if (seg.type === 'travel') {
          console.log(`    From: ${seg.from}`);
          console.log(`    To: ${seg.to}`);
          console.log(`    Time Range: ${seg.timeRange}`);
        }
      });
    } catch (e) {
      console.error('Parse error:', e.message);
    }
  });
});

req.on('error', (error) => {
  console.error(error);
});

req.end();
