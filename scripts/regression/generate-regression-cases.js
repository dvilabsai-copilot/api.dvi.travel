#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname);

function addDays(baseDate, offset) {
  const [year, month, day] = baseDate.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day + offset);
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dt = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dt}`;
}

function at(date, time) {
  return `${date}T${time}+05:30`;
}

function makeRoute(index, date, source, destination, km, direct = 0, viaRoute = '', viaRoutes = []) {
  return {
    location_name: source,
    next_visiting_location: destination,
    itinerary_route_date: at(date, '00:00:00'),
    no_of_days: index,
    no_of_km: km,
    direct_to_next_visiting_place: direct,
    via_route: viaRoute,
    via_routes: viaRoutes,
  };
}

function makePayload(caseDef) {
  const baseDate = caseDef.baseDate;
  const pickupTime = caseDef.pickupTime || '08:00:00';
  const endTime = caseDef.endTime || '20:00:00';
  const firstDate = addDays(baseDate, 0);
  const lastDate = addDays(baseDate, caseDef.routes.length - 1);
  const routeSource = caseDef.routes[0]?.source || 'Cochin International Airport';
  const routeDestination = caseDef.routes[caseDef.routes.length - 1]?.destination || routeSource;

  return {
    caseId: caseDef.caseId,
    description: caseDef.description,
    tags: caseDef.tags || [],
    manualHotspot: caseDef.manualHotspot || null,
    payload: {
      plan: {
        itinerary_plan_id: caseDef.planId,
        agent_id: 126,
        staff_id: 0,
        location_id: 0,
        arrival_point: routeSource,
        departure_point: routeDestination,
        itinerary_preference: 2,
        itinerary_type: 2,
        preferred_hotel_category: [],
        hotel_facilities: [],
        trip_start_date: at(firstDate, pickupTime),
        trip_end_date: at(lastDate, endTime),
        pick_up_date_and_time: at(firstDate, pickupTime),
        arrival_type: caseDef.arrivalType ?? 1,
        departure_type: caseDef.departureType ?? 1,
        no_of_nights: Math.max(0, caseDef.routes.length - 1),
        no_of_days: caseDef.routes.length,
        budget: caseDef.budget || 15000,
        entry_ticket_required: caseDef.entryTicketRequired ?? 0,
        guide_for_itinerary: caseDef.guideForItinerary ?? 0,
        nationality: 101,
        food_type: 0,
        meal_plan_code: caseDef.mealPlanCode || 'CP',
        meal_plan_breakfast: 1,
        meal_plan_lunch: 0,
        meal_plan_dinner: 0,
        adult_count: caseDef.adultCount || 2,
        child_count: 0,
        infant_count: 0,
        special_instructions: caseDef.specialInstructions || caseDef.description,
      },
      routes: caseDef.routes.map((route, idx) =>
        makeRoute(
          idx + 1,
          addDays(baseDate, idx),
          route.source,
          route.destination,
          route.km,
          route.direct || 0,
          route.viaRoute || '',
          route.viaRoutes || [],
        ),
      ),
      vehicles: [{ vehicle_type_id: caseDef.vehicleTypeId || 1, vehicle_count: caseDef.vehicleCount || 1 }],
      travellers: caseDef.travellers || [
        { room_id: 1, traveller_type: 1 },
        { room_id: 1, traveller_type: 1 },
      ],
      previousDayBillingDecisionProvided: false,
      previousDayBillingConfirmed: false,
    },
  };
}

const cases = [
  {
    caseId: 'regression-case-01',
    planId: 9301,
    baseDate: '2026-07-01',
    description: 'Airport -> Cochin -> Munnar -> Munnar -> Cochin Airport',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126, direct: 1 },
      { source: 'Munnar', destination: 'Munnar', km: 1 },
      { source: 'Munnar', destination: 'Munnar', km: 1 },
      { source: 'Munnar', destination: 'Cochin', km: 126 },
      { source: 'Cochin', destination: 'Cochin International Airport', km: 29.83 },
      { source: 'Cochin International Airport', destination: 'Cochin International Airport', km: 1 },
    ],
  },
  {
    caseId: 'regression-case-02',
    planId: 9302,
    baseDate: '2026-07-10',
    description: 'Cochin -> Munnar -> Munnar -> Thekkady -> Thekkady',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126, direct: 1 },
      { source: 'Munnar', destination: 'Munnar', km: 1 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Thekkady', km: 1 },
      { source: 'Thekkady', destination: 'Cochin', km: 138 },
      { source: 'Cochin', destination: 'Cochin International Airport', km: 29.83 },
    ],
  },
  {
    caseId: 'regression-case-03',
    planId: 9303,
    baseDate: '2026-07-20',
    description: 'Cochin -> Munnar -> Thekkady -> Alleppey -> Kumarakom -> Kumarakom',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin International Airport', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-04',
    planId: 9304,
    baseDate: '2026-07-30',
    description: 'Direct ON Cochin -> Munnar',
    routes: [
      { source: 'Cochin', destination: 'Munnar', km: 126, direct: 1 },
      { source: 'Munnar', destination: 'Munnar', km: 1 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-05',
    planId: 9305,
    baseDate: '2026-08-09',
    description: 'Direct OFF Cochin -> Munnar',
    routes: [
      { source: 'Cochin', destination: 'Munnar', km: 126, direct: 0 },
      { source: 'Munnar', destination: 'Munnar', km: 1 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-06',
    planId: 9306,
    baseDate: '2026-08-19',
    description: 'Via Route Chennai -> Mahabalipuram -> Pondicherry',
    routes: [
      { source: 'Chennai', destination: 'Mahabalipuram', km: 58, direct: 0, viaRoute: 'Mahabalipuram' },
      { source: 'Mahabalipuram', destination: 'Pondicherry', km: 100, direct: 0, viaRoute: 'Pondicherry' },
      { source: 'Pondicherry', destination: 'Pondicherry', km: 1 },
      { source: 'Pondicherry', destination: 'Chennai', km: 160 },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Mahabalipuram', km: 58 },
      { source: 'Mahabalipuram', destination: 'Chennai', km: 58 },
    ],
  },
  {
    caseId: 'regression-case-07',
    planId: 9307,
    baseDate: '2026-08-29',
    description: 'Same-city chain Kumarakom -> Kumarakom -> Kumarakom',
    routes: [
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Alleppey', km: 32.7 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
    ],
  },
  {
    caseId: 'regression-case-08',
    planId: 9308,
    baseDate: '2026-09-08',
    description: 'Same-city chain after intercity transfer Alleppey -> Kumarakom -> Kumarakom',
    routes: [
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Kumarakom, Kerala, India', km: 97.1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-09',
    planId: 9309,
    baseDate: '2026-09-18',
    description: 'Long route Chennai -> Kanchipuram -> Tiruvannamalai -> Vellore',
    routes: [
      { source: 'Chennai', destination: 'Kanchipuram', km: 75, direct: 0 },
      { source: 'Kanchipuram', destination: 'Tiruvannamalai', km: 110 },
      { source: 'Tiruvannamalai', destination: 'Vellore', km: 120 },
      { source: 'Vellore', destination: 'Vellore', km: 1 },
      { source: 'Vellore', destination: 'Chennai', km: 140 },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Kanchipuram', km: 75 },
    ],
  },
  {
    caseId: 'regression-case-10',
    planId: 9310,
    baseDate: '2026-09-28',
    description: 'Arrival city == departure city',
    routes: [
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Mahabalipuram', km: 58 },
      { source: 'Mahabalipuram', destination: 'Chennai', km: 58 },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Kanchipuram', km: 75 },
      { source: 'Kanchipuram', destination: 'Chennai', km: 75 },
    ],
  },
  {
    caseId: 'regression-case-11',
    planId: 9311,
    baseDate: '2026-10-08',
    description: 'Late arrival after 4 PM',
    pickupTime: '16:30:00',
    endTime: '20:30:00',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126, direct: 1 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin International Airport', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-12',
    planId: 9312,
    baseDate: '2026-10-18',
    description: 'Last day departure after 6 PM',
    endTime: '21:30:00',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin International Airport', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-13',
    planId: 9313,
    baseDate: '2026-10-28',
    description: 'Manual hotspot insertion',
    manualHotspot: {
      routeDay: 2,
      strategy: 'source-city-first-available',
    },
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Kumarakom, Kerala, India', km: 1 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin International Airport', km: 61.47 },
    ],
  },
  {
    caseId: 'regression-case-14',
    planId: 9314,
    baseDate: '2026-11-07',
    description: 'Corridor hotspot route',
    routes: [
      { source: 'Chennai', destination: 'Mahabalipuram', km: 58, direct: 0, viaRoute: 'Mahabalipuram' },
      { source: 'Mahabalipuram', destination: 'Pondicherry', km: 100, direct: 0, viaRoute: 'Pondicherry' },
      { source: 'Pondicherry', destination: 'Chennai', km: 160, direct: 0, viaRoute: 'Chennai corridor' },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
      { source: 'Chennai', destination: 'Mahabalipuram', km: 58 },
      { source: 'Mahabalipuram', destination: 'Chennai', km: 58 },
      { source: 'Chennai', destination: 'Chennai', km: 1 },
    ],
  },
  {
    caseId: 'regression-case-15',
    planId: 9315,
    baseDate: '2026-11-17',
    description: 'Multi-city 10-day itinerary',
    routes: [
      { source: 'Cochin International Airport', destination: 'Cochin', km: 29.83, direct: 1 },
      { source: 'Cochin', destination: 'Munnar', km: 126 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Alleppey', km: 138 },
      { source: 'Alleppey', destination: 'Kumarakom, Kerala, India', km: 32.7 },
      { source: 'Kumarakom, Kerala, India', destination: 'Cochin', km: 61.47 },
      { source: 'Cochin', destination: 'Munnar', km: 126 },
      { source: 'Munnar', destination: 'Thekkady', km: 97.1 },
      { source: 'Thekkady', destination: 'Cochin', km: 138 },
      { source: 'Cochin', destination: 'Cochin International Airport', km: 29.83 },
    ],
  },
];

for (const caseDef of cases) {
  const fileName = `${caseDef.caseId}.json`;
  const outPath = path.join(OUT_DIR, fileName);
  const payload = makePayload(caseDef);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${fileName}`);
}

