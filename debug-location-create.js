const API_URL = 'http://127.0.0.1:4006/api/v1/locations';
const TOKEN = process.env.LOCATIONS_TOKEN ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzQ5NDAwMTgsImV4cCI6MTc3NTU0NDgxOH0.Lhz9L-0iArKuhe4sXvl_hqoJXFnj0vOcbdLjbFMi77k';

const payload = {
  source_location: 'Moosapet',
  source_city: 'Hyderabad',
  source_state: 'Telangana',
  source_latitude: '17.4665',
  source_longitude: '78.4254',
};

async function run() {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {}

  console.log('status:', response.status);
  console.log('body:', parsed);

  if (!response.ok) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error('request failed:', err);
  process.exit(1);
});
