const DEFAULT_BASE_URL = 'http://127.0.0.1:4006/api/v1';

function getArg(flagName, fallback) {
  const index = process.argv.indexOf(flagName);
  if (index >= 0 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return fallback;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }
  return number.toFixed(2);
}

function pad(value, length) {
  return String(value ?? '').padEnd(length, ' ');
}

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

async function main() {
  const quoteId = getArg('--quote', process.env.ITINERARY_QUOTE_ID || 'DVI20260588');
  const token = getArg('--token', process.env.ITINERARY_BEARER_TOKEN || '');
  const baseUrl = getArg('--base-url', process.env.ITINERARY_BASE_URL || DEFAULT_BASE_URL);

  if (!token) {
    console.error('Missing bearer token. Pass --token or set ITINERARY_BEARER_TOKEN.');
    process.exit(1);
  }

  const url = `${baseUrl}/itineraries/details/${encodeURIComponent(quoteId)}`;
  console.log(`Fetching ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  const bodyText = await response.text();
  console.log(`HTTP ${response.status}`);

  if (!response.ok) {
    console.error(bodyText);
    process.exit(1);
  }

  const payload = JSON.parse(bodyText);
  const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles : [];

  console.log(`Quote: ${payload.quoteId}`);
  console.log(`Plan ID: ${payload.planId}`);
  console.log(`Vehicles returned: ${vehicles.length}`);

  if (!vehicles.length) {
    console.log('No vehicles array in response.');
    return;
  }

  vehicles.forEach((vehicle, vehicleIndex) => {
    console.log('');
    console.log(`Vehicle ${vehicleIndex + 1}: ${vehicle.vehicleTypeName || '-'} | origin=${vehicle.vehicleOrigin || '-'} | total=${formatMoney(vehicle.totalCostOfVehicle)}`);

    const availableSlabs = Array.isArray(vehicle.availableSlabs) ? vehicle.availableSlabs : [];
    console.log(`Available slabs: ${availableSlabs.length ? availableSlabs.map((slab) => slab.title || slab.timeLimitTitle || slab.time_limit_title || slab.time_limit_id).join(', ') : '(none)'}`);

    const dayWisePricing = Array.isArray(vehicle.dayWisePricing) ? vehicle.dayWisePricing : [];
    if (!dayWisePricing.length) {
      console.log('No dayWisePricing rows.');
      return;
    }

    console.log('Day                       Slab Field   Slab Value            Rental     Total      Route');
    console.log('------------------------  -----------  -------------------  ---------  ---------  -----------------------------');

    for (const row of dayWisePricing) {
      const dayLabel = pad(row.dayLabel || row.date || '-', 24);
      const slabField = pad(hasOwn(row, 'slabTitle') ? 'present' : 'missing', 11);
      const slabTitle = pad(row.slabTitle || '-', 19);
      const rental = pad(formatMoney(row.rentalCharges), 9);
      const total = pad(formatMoney(row.totalCharges), 9);
      const routeLabel = row.route || '-';
      console.log(`${dayLabel}  ${slabField}  ${slabTitle}  ${rental}  ${total}  ${routeLabel}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});