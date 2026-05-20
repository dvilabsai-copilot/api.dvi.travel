const DEFAULT_BASE_URL = 'https://dvi.travel/api/v1';
const DEFAULT_HOTELS = [
  'AX_DVI_HOTEL_153',
  'AX_DVI_HOTEL_44578',
  'AX_DVI_HOTEL_44579',
  'AX_DVI_HOTEL_459',
];

function readJson(text) {
  return JSON.parse(text);
}

function getEnvList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function safeStringify(value) {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === 'bigint' ? val.toString() : val),
    2,
  );
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = readJson(text);
  } catch {
    parsed = text;
  }

  return {
    statusCode: response.status,
    body: parsed,
  };
}

function normalizeRatePlanData(data) {
  return Array.isArray(data) ? data : [];
}

function occupancySignature(entry) {
  return Array.isArray(entry?.occupancy) ? entry.occupancy.join('|') : '';
}

async function checkHotel(baseUrl, authKey, propertyId, referenceOccupancySignature) {
  const productInfo = await postJson(`${baseUrl}/axisrooms/productInfo`, {
    auth: { key: authKey },
    propertyId,
  });

  const productBody = productInfo.body && typeof productInfo.body === 'object' ? productInfo.body : {};
  const rooms = Array.isArray(productBody.data) ? productBody.data : [];

  const roomChecks = [];
  for (const room of rooms) {
    const ratePlanInfo = await postJson(`${baseUrl}/axisrooms/ratePlanInfo`, {
      auth: { key: authKey },
      propertyId,
      roomId: room.id,
    });

    const rateBody = ratePlanInfo.body && typeof ratePlanInfo.body === 'object' ? ratePlanInfo.body : {};
    const ratePlans = normalizeRatePlanData(rateBody.data);
    const occupancyMatches =
      ratePlanInfo.statusCode === 200 &&
      String(rateBody.status || '').toLowerCase() === 'success' &&
      ratePlans.length > 0 &&
      ratePlans.every((entry) => occupancySignature(entry) === referenceOccupancySignature);

    roomChecks.push({
      roomId: room.id,
      roomName: room.name,
      statusCode: ratePlanInfo.statusCode,
      responseStatus: rateBody.status,
      ratePlanCount: ratePlans.length,
      occupancyMatches,
      firstRatePlan: ratePlans[0] || null,
    });
  }

  const productOk =
    productInfo.statusCode === 200 &&
    String(productBody.status || '').toLowerCase() === 'success' &&
    rooms.length > 0;

  const allRoomsOk = roomChecks.length > 0 && roomChecks.every((check) => check.occupancyMatches);

  return {
    propertyId,
    productInfo: {
      statusCode: productInfo.statusCode,
      responseStatus: productBody.status,
      roomCount: rooms.length,
      ok: productOk,
    },
    roomChecks,
    ok: productOk && allRoomsOk,
  };
}

async function main() {
  const baseUrl = process.env.AXISROOMS_BASE_URL || DEFAULT_BASE_URL;
  const authKey = process.env.AXISROOMS_AUTH_KEY || process.env.AXISROOMS_API_KEY;
  const hotels = getEnvList('AXISROOMS_HOTELS', DEFAULT_HOTELS);

  if (!authKey) {
    throw new Error('Set AXISROOMS_AUTH_KEY before running this script.');
  }

  const referencePropertyId = hotels[0] || DEFAULT_HOTELS[0];
  const reference = await checkHotel(baseUrl, authKey, referencePropertyId, '');
  const referenceFirstRoom = reference.roomChecks[0];
  const referenceOccupancySignature = referenceFirstRoom?.firstRatePlan
    ? occupancySignature(referenceFirstRoom.firstRatePlan)
    : '';

  const results = [];
  for (const propertyId of hotels) {
    results.push(await checkHotel(baseUrl, authKey, propertyId, referenceOccupancySignature));
  }

  const failedHotels = results.filter((hotel) => !hotel.ok);

  console.log(
    safeStringify({
      summary: {
        totalHotels: results.length,
        passedHotels: results.length - failedHotels.length,
        failedHotels: failedHotels.length,
        referencePropertyId,
        referenceOccupancySignature,
      },
      results,
    }),
  );

  if (failedHotels.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});