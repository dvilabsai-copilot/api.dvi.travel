import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BASE_URL = process.env.ITINERARY_API_BASE_URL || 'http://127.0.0.1:4006/api/v1';
const AUTH_TOKEN =
  process.env.ITINERARY_API_TOKEN ||
  'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3ODA3NzMwNzYsImV4cCI6MTc4MTM3Nzg3Nn0.el4nJQV6crdztkcV7A4oCQxJ_FrfrGtOfFZFJGFf1lQ';
const PLAN_ID = Number(process.env.PLAN_ID || 9599);
const cleanJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_, current) => (typeof current === 'bigint' ? Number(current) : current)),
  );
const toIso = (value: unknown) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+05:30`;
};

async function getPayloadFromDb(planId: number) {
  const plan = await prisma.dvi_itinerary_plan_details.findUnique({
    where: { itinerary_plan_ID: planId },
  });
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const routes = await prisma.dvi_itinerary_route_details.findMany({
    where: { itinerary_plan_ID: planId, deleted: 0 },
    orderBy: { no_of_days: 'asc' },
  });

  const vehicles = await prisma.dvi_itinerary_plan_vehicle_details.findMany({
    where: { itinerary_plan_id: planId, deleted: 0, status: 1 },
    orderBy: { vehicle_details_ID: 'asc' },
    select: {
      vehicle_type_id: true,
      vehicle_count: true,
    },
  });

  const travellers = await prisma.dvi_itinerary_traveller_details.findMany({
    where: { itinerary_plan_ID: planId, deleted: 0, status: 1 },
    orderBy: { traveller_details_ID: 'asc' },
    select: {
      room_id: true,
      traveller_type: true,
    },
  });

  const routeIdRows = routes.map((route) => Number(route.itinerary_route_ID || 0));
  const viaRows = await prisma.dvi_itinerary_via_route_details.findMany({
    where: {
      itinerary_plan_ID: planId,
      itinerary_route_ID: { in: routeIdRows },
      deleted: 0,
      status: 1,
    },
    orderBy: { itinerary_via_route_ID: 'asc' },
    select: {
      itinerary_route_ID: true,
      itinerary_via_location_name: true,
    },
  });

  const viaByRouteId = new Map<number, string[]>();
  for (const row of viaRows) {
    const routeId = Number(row.itinerary_route_ID || 0);
    if (!viaByRouteId.has(routeId)) viaByRouteId.set(routeId, []);
    viaByRouteId.get(routeId)!.push(String(row.itinerary_via_location_name || '').trim());
  }

  return cleanJson({
    plan: {
      itinerary_plan_id: plan.itinerary_plan_ID,
      agent_id: plan.agent_id,
      staff_id: plan.staff_id,
      location_id: plan.location_id,
      arrival_point: plan.arrival_location,
      departure_point: plan.departure_location,
      itinerary_preference: plan.itinerary_preference,
      itinerary_type: plan.itinerary_type,
      preferred_hotel_category: Array.isArray((plan as any).preferred_hotel_category)
        ? (plan as any).preferred_hotel_category
        : [],
      hotel_facilities: Array.isArray((plan as any).hotel_facilities)
        ? (plan as any).hotel_facilities
        : [],
      trip_start_date: toIso(plan.trip_start_date),
      trip_end_date: toIso(plan.trip_end_date),
      pick_up_date_and_time: toIso(plan.pick_up_date_and_time),
      arrival_type: plan.arrival_type,
      departure_type: plan.departure_type,
      no_of_nights: plan.no_of_nights,
      no_of_days: plan.no_of_days,
      budget: Number(plan.budget || 0),
      entry_ticket_required: plan.entry_ticket_required,
      guide_for_itinerary: plan.guide_for_itinerary,
      nationality: plan.nationality,
      food_type: plan.food_type,
      meal_plan_breakfast: (plan as any).meal_plan_breakfast,
      meal_plan_lunch: (plan as any).meal_plan_lunch,
      meal_plan_dinner: (plan as any).meal_plan_dinner,
      adult_count: Number(plan.adult_count || 0),
      child_count: Number(plan.child_count || 0),
      infant_count: Number(plan.infant_count || 0),
      special_instructions: plan.special_instructions || '',
    },
    routes: routes.map((route) => ({
      location_name: route.location_name,
      next_visiting_location: route.next_visiting_location,
      itinerary_route_date: toIso(route.itinerary_route_date),
      no_of_days: route.no_of_days,
      no_of_km: Number(route.no_of_km || 0),
      direct_to_next_visiting_place: route.direct_to_next_visiting_place,
      via_route: route.via_route || '',
      via_routes: viaByRouteId.get(Number(route.itinerary_route_ID || 0)) || [],
    })),
    vehicles: vehicles.map((vehicle) => ({
      vehicle_type_id: Number(vehicle.vehicle_type_id || 0),
      vehicle_count: Number(vehicle.vehicle_count || 0),
    })),
    travellers: travellers.map((traveller) => ({
      room_id: Number(traveller.room_id || 0),
      traveller_type: Number(traveller.traveller_type || 0),
    })),
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false,
  });
}

async function querySuspiciousRows(planId: number) {
  return prisma.$queryRawUnsafe(`
    SELECT
      vd.itinerary_plan_vendor_vehicle_details_ID,
      vd.itinerary_plan_vendor_eligible_ID,
      vd.itinerary_route_id,
      DATE(vd.itinerary_route_date) AS route_date,
      vd.vendor_id,
      vd.vendor_branch_id,
      vd.vendor_vehicle_type_id,
      vd.vehicle_id,
      vd.itinerary_route_location_from,
      vd.itinerary_route_location_to,
      vd.total_pickup_km,
      CAST(vd.total_pickup_duration AS CHAR) AS total_pickup_duration,
      vd.total_running_km,
      vd.total_siteseeing_km,
      vd.total_drop_km,
      vd.total_travelled_km,
      vd.status,
      vd.deleted
    FROM dvi_itinerary_plan_vendor_vehicle_details vd
    WHERE vd.itinerary_plan_id = ${planId}
      AND vd.deleted = 0
      AND vd.total_pickup_km > 1000
    ORDER BY vd.itinerary_route_date, vd.vendor_id, vd.vendor_vehicle_type_id
  `);
}

async function main() {
  console.log('[REPRO] building payload from DB', { planId: PLAN_ID, baseUrl: BASE_URL });
  const payload = await getPayloadFromDb(PLAN_ID);
  console.log('[REPRO] suspicious rows before save', await querySuspiciousRows(PLAN_ID));

  const response = await fetch(`${BASE_URL}/itineraries/?type=itineary_basic_info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: AUTH_TOKEN.startsWith('Bearer ') ? AUTH_TOKEN : `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  console.log('[REPRO] save response', {
    status: response.status,
    ok: response.ok,
    bodyText,
  });

  console.log('[REPRO] suspicious rows after save', await querySuspiciousRows(PLAN_ID));
}

main()
  .catch((error) => {
    console.error('[REPRO] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
