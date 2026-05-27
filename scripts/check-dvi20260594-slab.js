const { PrismaClient } = require('@prisma/client');

const API_URL = 'http://127.0.0.1:4006/api/v1/itineraries/details/DVI20260594';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function approx(value, expected, tolerance = 1.0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - expected) <= tolerance;
}

(async () => {
  const token = process.env.DVI_AUTH_TOKEN;
  if (!token) {
    fail('Set DVI_AUTH_TOKEN before running this script');
  }

  const prisma = new PrismaClient();

  try {
    const resp = await fetch(API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!resp.ok) {
      fail(`API request failed: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const vehicle = Array.isArray(data.vehicles) ? data.vehicles[0] : null;
    if (!vehicle) fail('No vehicle found in response');

    const rows = Array.isArray(vehicle.dayWisePricing) ? vehicle.dayWisePricing : [];
    const d1 = rows[0] || null;
    const d2 = rows[1] || null;
    const d3 = rows[2] || null;
    const d4 = rows[3] || null;

    console.log('quoteId:', data.quoteId);
    console.log('vendorName:', vehicle.vendorName);
    console.log('vehicleTypeName:', vehicle.vehicleTypeName);
    console.log('selectedTimeLimitId:', vehicle.selectedTimeLimitId);
    console.log('availableSlabs:', JSON.stringify(vehicle.availableSlabs || [], null, 2));
    console.log('Day1:', JSON.stringify(d1, null, 2));
    console.log('Day2:', JSON.stringify(d2, null, 2));
    console.log('Day3:', JSON.stringify(d3, null, 2));
    console.log('Day4:', JSON.stringify(d4, null, 2));

    const eligibleId = Number(vehicle.vendorEligibleId || 0);
    const eligibleRows = eligibleId > 0
      ? await prisma.$queryRaw`SELECT vendor_id, vendor_vehicle_type_id, vendor_branch_id FROM dvi_itinerary_plan_vendor_eligible_list WHERE itinerary_plan_vendor_eligible_ID = ${eligibleId} LIMIT 1`
      : await prisma.$queryRaw`SELECT vendor_id, vendor_vehicle_type_id, vendor_branch_id FROM dvi_itinerary_plan_vendor_eligible_list WHERE itinerary_plan_ID = ${Number(data.planId)} AND status = 1 AND deleted = 0 LIMIT 1`;

    const eligible = Array.isArray(eligibleRows) ? eligibleRows[0] : null;
    const safeVendorId = Number(eligible?.vendor_id || 0);
    const safeVendorVehicleTypeId = Number(eligible?.vendor_vehicle_type_id || 0);
    const safeVendorBranchId = Number(eligible?.vendor_branch_id || 0);

    const timeLimitRows = await prisma.$queryRaw`
      SELECT time_limit_id, time_limit_title, hours_limit, km_limit, vendor_id, vendor_vehicle_type_id
      FROM dvi_time_limit
      WHERE vendor_id = ${safeVendorId}
        AND vendor_vehicle_type_id = ${safeVendorVehicleTypeId}
        AND status = 1
        AND deleted = 0
      ORDER BY hours_limit, km_limit, time_limit_id
    `;

    console.log('dvi_time_limit rows:', JSON.stringify(timeLimitRows, null, 2));

    const availableTimeLimitIds = (vehicle.availableSlabs || [])
      .map((s) => Number(s.timeLimitId || 0))
      .filter((n) => Number.isFinite(n) && n > 0);

    const pricebookRows = await prisma.$queryRawUnsafe(
      `SELECT vendor_id, vendor_branch_id, vehicle_type_id, time_limit_id, year, month, day_28
       FROM dvi_vehicle_local_pricebook
       WHERE vendor_id = ?
         AND vendor_branch_id = ?
         AND vehicle_type_id = ?
         AND year = ?
         AND month = ?
         AND status = 1
         AND deleted = 0
         ${availableTimeLimitIds.length ? `AND time_limit_id IN (${availableTimeLimitIds.map(() => '?').join(',')})` : ''}
       ORDER BY time_limit_id`,
      safeVendorId,
      safeVendorBranchId,
      safeVendorVehicleTypeId,
      '2026',
      'May',
      ...availableTimeLimitIds,
    );

    console.log('dvi_vehicle_local_pricebook rows (May 2026, day_28):', JSON.stringify(pricebookRows, null, 2));

    const v = [];
    const d1OkSlab = !!d1 && ((String(d1.slabTitle || '').toUpperCase().includes('12 HRS 120')) || Number(d1.slabKmLimit || 0) === 120);
    const d1Sightseeing = !!d1 && Number(d1.sightseeingKms || 0) > 0;
    const d1Total = !!d1 && approx(d1.totalKms, 120.82, 1.5);
    const d1ExtraNot21 = !!d1 && Number(d1.extraKms || 0) <= 1;
    const d1Not100Slab = !!d1 && !String(d1.slabTitle || '').toUpperCase().includes('10 HRS 100');
    const d2Ok = !!d2 && Number(d2.sightseeingKms || 0) > 0;
    const d3Ok = !!d3 && Number(d3.sightseeingKms || 0) > 0;

    if (d1OkSlab) v.push('? Day 1 selected 12 HRS 120 KM'); else v.push('? Day 1 slab is not 12 HRS 120');
    if (d1Sightseeing) v.push('? Day 1 sightseeing is preserved'); else v.push('? Day 1 sightseeing is zero');
    if (d1Total) v.push('? Day 1 total KM is around 120.82'); else v.push('? Day 1 total KM is off from 120.82');
    if (d1ExtraNot21) v.push('? Day 1 extra KM is not using 10 HRS 100 baseline'); else v.push('? Day 1 extra KM still looks like 10 HRS 100 baseline');
    if (d1Not100Slab) v.push('? Day 1 is not on 10 HRS 100 slab'); else v.push('? Day 1 still on 10 HRS 100 slab');
    if (d2Ok) v.push('? Day 2 did not regress'); else v.push('? Day 2 regressed');
    if (d3Ok) v.push('? Day 3 did not regress'); else v.push('? Day 3 regressed');

    for (const line of v) console.log(line);

    const failed = v.some((line) => line.startsWith('?'));
    if (failed) process.exitCode = 2;
  } catch (err) {
    console.error('Script failed:', err?.message || err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
