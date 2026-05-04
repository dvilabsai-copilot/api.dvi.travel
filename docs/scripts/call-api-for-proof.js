async function main() {
  try {
    const res = await fetch('http://localhost:4006/api/v1/itineraries/details/DVI202604230');
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
