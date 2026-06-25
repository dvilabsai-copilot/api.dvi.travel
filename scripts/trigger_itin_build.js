const fs = require('fs');
const path = require('path');

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function loadPayload() {
  const payloadFile =
    process.env.PAYLOAD_FILE ||
    process.env.ITIN_PAYLOAD_FILE ||
    process.env.REGRESSION_PAYLOAD_FILE ||
    '';

  if (payloadFile) {
    const resolved = path.resolve(payloadFile);
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.payload ? parsed.payload : parsed;
  }

  throw new Error('Missing payload file. Set PAYLOAD_FILE or ITIN_PAYLOAD_FILE.');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatMinutes(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
  if (!safeMinutes) return '-';
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  return minutes === 0 ? `${hours} HRS` : `${hours} HRS ${minutes} MIN`;
}

function sortSlabs(slabs) {
  return [...slabs].sort((a, b) => {
    const aHours = Number(a?.hoursLimit || 0);
    const bHours = Number(b?.hoursLimit || 0);
    if (aHours !== bHours) return aHours - bHours;
    const aKm = Number(a?.kmLimit || 0);
    const bKm = Number(b?.kmLimit || 0);
    if (aKm !== bKm) return aKm - bKm;
    return Number(a?.timeLimitId || 0) - Number(b?.timeLimitId || 0);
  });
}

function findChargeableCoveringSlab(slabs, dutyHours, dutyKm) {
  const sorted = sortSlabs(slabs || []);
  return sorted.find((slab) => (
    Number(slab?.hoursLimit || 0) >= dutyHours &&
    Number(slab?.kmLimit || 0) >= dutyKm
  )) || null;
}

function findTargetVehicle(vehicles) {
  const rows = Array.isArray(vehicles) ? vehicles : [];
  return (
    rows.find((vehicle) => String(vehicle?.vehicleTypeName || '').toLowerCase().includes('sedan')) ||
    rows.find((vehicle) => Array.isArray(vehicle?.dayWisePricing) && vehicle.dayWisePricing.some((day) => String(day?.travelType || '').toLowerCase() === 'local')) ||
    rows[0] ||
    null
  );
}

function findFirstLocalDay(vehicle) {
  const days = Array.isArray(vehicle?.dayWisePricing) ? vehicle.dayWisePricing : [];
  return days.find((day) => String(day?.travelType || '').toLowerCase() === 'local') || null;
}

async function fetchItineraryDetails(apiBase, token, quoteId) {
  const resp = await fetch(`${apiBase}/itineraries/details/${encodeURIComponent(String(quoteId))}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  const parsed = safeJsonParse(text);
  if (!resp.ok || !parsed) {
    throw new Error(`Failed to fetch itinerary details for ${quoteId}. status=${resp.status}`);
  }
  return parsed;
}

function verifyDayOneSlab(detailsPayload, quoteId) {
  const vehicles = Array.isArray(detailsPayload?.vehicles) ? detailsPayload.vehicles : [];
  const vehicle = findTargetVehicle(vehicles);
  if (!vehicle) {
    throw new Error(`No vehicle rows found in details for ${quoteId}`);
  }

  const day = findFirstLocalDay(vehicle);
  if (!day) {
    throw new Error(`No local day found in details for ${quoteId}`);
  }

  const actualMinutes = Number(day?.totalDurationMinutes || 0);
  const actualHours = actualMinutes > 0 ? actualMinutes / 60 : 0;
  const actualKm = Number(day?.totalKms || 0);
  const availableSlabs = Array.isArray(vehicle?.availableSlabs) ? vehicle.availableSlabs : [];
  const chargeableHours = Number(day?.slabHoursLimit || 0);
  const chargeableKm = Number(day?.slabKmLimit || 0);
  const coveringSlab = findChargeableCoveringSlab(availableSlabs, actualHours, actualKm);
  const noHigherSlabAvailable = !coveringSlab;
  const chargeableMatchesCovering = coveringSlab
    ? Number(coveringSlab.hoursLimit || 0) === chargeableHours &&
      Number(coveringSlab.kmLimit || 0) === chargeableKm
    : true;
  const zeroExtraHourWhenCovered = coveringSlab ? Number(day?.extraHourCharges || 0) === 0 : true;
  const zeroExtraKmWhenCovered =
    coveringSlab
      ? Number(day?.extraKmCharges || 0) === 0 && Number(vehicle?.localExtraKmCharge || 0) === 0
      : true;

  const summary = {
    quoteId,
    vehicleTypeName: vehicle?.vehicleTypeName || null,
    dayLabel: day?.dayLabel || null,
    actualUsageTime: formatMinutes(actualMinutes),
    actualUsageKm: Number(actualKm.toFixed(2)),
    originalSlabTitle: day?.originalSlabTitle || null,
    chargeableSlab: day?.chargeableSlabTitle || day?.slabTitle || null,
    chargeableHours,
    chargeableKm,
    rentalCharge: Number(day?.rentalCharges || 0),
    extraHourCount: Number(day?.extraHourCount || 0),
    extraHourCharge: Number(day?.extraHourCharges || 0),
    localExtraKms: Number(vehicle?.localExtraKms || 0),
    localExtraKmCharge: Number(vehicle?.localExtraKmCharge || 0),
    coveringSlab: coveringSlab
      ? {
          title: coveringSlab.title || null,
          hoursLimit: Number(coveringSlab.hoursLimit || 0),
          kmLimit: Number(coveringSlab.kmLimit || 0),
        }
      : null,
    noHigherSlabAvailable,
  };

  if (noHigherSlabAvailable) {
    console.log('NO HIGHER SLAB AVAILABLE IN PRICEBOOK');
    if (actualHours > chargeableHours && Number(day?.extraHourCharges || 0) <= 0) {
      throw new Error(`No higher slab available, but extra hour charge is still zero for ${quoteId}`);
    }
  } else {
    if (!chargeableMatchesCovering) {
      throw new Error(
        `Chargeable package mismatch for ${quoteId}. expected ${coveringSlab.hoursLimit}/${coveringSlab.kmLimit}, got ${chargeableHours}/${chargeableKm}`,
      );
    }
    if (!zeroExtraHourWhenCovered) {
      throw new Error(`Extra hour charge should be zero when higher slab covers usage for ${quoteId}`);
    }
    if (!zeroExtraKmWhenCovered) {
      throw new Error(`Local extra KM charge should be zero when higher slab covers usage for ${quoteId}`);
    }
  }

  if (
    coveringSlab &&
    actualHours > 8 &&
    chargeableHours <= 8 &&
    Number(coveringSlab.hoursLimit || 0) > 8
  ) {
    throw new Error(`Day 1 still shows 8-hour slab while a higher covering slab exists for ${quoteId}`);
  }

  return summary;
}

async function ensureToken(apiBase) {
  const email = String(process.env.PROD_EMAIL || process.env.DVI_EMAIL || 'admin@dvi.co.in').trim();
  const password = String(process.env.PROD_PASSWORD || process.env.DVI_PASSWORD || '').trim();
  if (!password) {
    throw new Error('Missing DVI_PASSWORD');
  }

  const resp = await fetch(`${apiBase}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await resp.text();
  const payload = safeJsonParse(text);
  const token =
    payload?.data?.accessToken ||
    payload?.accessToken ||
    payload?.token ||
    payload?.data?.token ||
    payload?.data?.jwt ||
    payload?.jwt ||
    null;

  if (!token) {
    throw new Error(`Unable to obtain bearer token via login. status=${resp.status}`);
  }

  return token;
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.BASE_URL) || 'http://127.0.0.1:4006';
  const apiBase = `${baseUrl}/api/v1`;
  const token = String(process.env.REGRESSION_BEARER_TOKEN || '').trim() || (await ensureToken(apiBase));

  const payload = loadPayload();
  const resultFile = process.env.RESULT_FILE || process.env.REGRESSION_RESULT_FILE || '';
  const url = `${apiBase}/itineraries/?type=itineary_basic_info`;

  console.log('[TRIGGER_ITIN_BUILD] URL', url);

  let response;
  let text = '';
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    text = await response.text();
  } catch (err) {
    console.error('[TRIGGER_ITIN_BUILD] Request failed:', err?.message || String(err));
    if (resultFile) {
      try {
        fs.writeFileSync(path.resolve(resultFile), JSON.stringify({ error: err?.message || String(err) }, null, 2), 'utf8');
      } catch {
        // ignore write errors on request failure
      }
    }
    process.exit(1);
  }

  console.log('[TRIGGER_ITIN_BUILD] status', response.status);

  const parsed = safeJsonParse(text);
  if (resultFile) {
    try {
      fs.writeFileSync(path.resolve(resultFile), text, 'utf8');
    } catch (writeErr) {
      console.error('[TRIGGER_ITIN_BUILD] Failed to write result file:', writeErr.message);
    }
  }

  if (parsed) {
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(text);
  }

  const responseSummary = {
    quoteId: parsed?.quoteId || parsed?.data?.quoteId || parsed?.response?.quoteId || null,
    planId: parsed?.planId || parsed?.data?.planId || parsed?.response?.planId || null,
    successMarker:
      parsed?.success ??
      parsed?.ok ??
      parsed?.data?.success ??
      parsed?.data?.ok ??
      parsed?.response?.success ??
      parsed?.response?.ok ??
      parsed?.vehicleBuildStatus ??
      parsed?.data?.vehicleBuildStatus ??
      parsed?.response?.vehicleBuildStatus ??
      parsed?.message ??
      parsed?.data?.message ??
      parsed?.response?.message ??
      null,
  };
  console.log('[TRIGGER_ITIN_BUILD] response summary', responseSummary);

  const hasExpectedIdentifiers =
    responseSummary.quoteId != null &&
    responseSummary.planId != null &&
    (responseSummary.successMarker != null || response.ok);

  if (!response.ok) {
    console.error('[TRIGGER_ITIN_BUILD] Non-2xx build response');
    process.exit(1);
  }

  if (!parsed || !hasExpectedIdentifiers) {
    console.error('[TRIGGER_ITIN_BUILD] Missing expected response fields or invalid JSON');
    process.exit(1);
  }

  const resolvedQuoteId = responseSummary.quoteId;
  const details = await fetchItineraryDetails(apiBase, token, resolvedQuoteId);
  const verification = verifyDayOneSlab(details, resolvedQuoteId);
  console.log('[TRIGGER_ITIN_BUILD] verification summary', JSON.stringify(verification, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error('[TRIGGER_ITIN_BUILD] Unhandled failure:', err?.stack || err?.message || String(err));
  process.exit(1);
});
