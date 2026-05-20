async function main() {
  const token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhZG1pbkBkdmkuY28uaW4iLCJyb2xlIjoxLCJhZ2VudElkIjowLCJzdGFmZklkIjowLCJndWlkZUlkIjowLCJpYXQiOjE3NzY5NDk1OTYsImV4cCI6MTc3NzU1NDM5Nn0.WFkpSnnEEfdhmvImlztk8_K_ehebAcpShDSmUCk4qUI";

  const payload = {
    plan: {
      itinerary_plan_id: 284,
      agent_id: 126,
      staff_id: 0,
      location_id: 0,
      arrival_point: "Bangalore, International Airport",
      departure_point: "Madurai Airport",
      itinerary_preference: 3,
      itinerary_type: 2,
      preferred_hotel_category: [2],
      hotel_facilities: [],
      trip_start_date: "2026-04-28T11:00:00+05:30",
      trip_end_date: "2026-05-02T20:00:00+05:30",
      pick_up_date_and_time: "2026-04-28T11:00:00+05:30",
      arrival_type: 1,
      departure_type: 1,
      no_of_nights: 4,
      no_of_days: 5,
      budget: 15000,
      entry_ticket_required: 0,
      guide_for_itinerary: 0,
      nationality: 101,
      food_type: 0,
      adult_count: 1,
      child_count: 0,
      infant_count: 0,
      special_instructions: ""
    },
    routes: [
      {
        location_name: "Bangalore, International Airport",
        next_visiting_location: "Ooty",
        itinerary_route_date: "2026-04-28T00:00:00+05:30",
        no_of_days: 1,
        no_of_km: 312,
        direct_to_next_visiting_place: 1,
        via_route: "",
        via_routes: []
      },
      {
        location_name: "Ooty",
        next_visiting_location: "Ooty",
        itinerary_route_date: "2026-04-29T00:00:00+05:30",
        no_of_days: 2,
        no_of_km: 10,
        direct_to_next_visiting_place: 0,
        via_route: "",
        via_routes: []
      },
      {
        location_name: "Ooty",
        next_visiting_location: "Kodaikanal",
        itinerary_route_date: "2026-04-30T00:00:00+05:30",
        no_of_days: 3,
        no_of_km: 250,
        direct_to_next_visiting_place: 1,
        via_route: "",
        via_routes: []
      },
      {
        location_name: "Kodaikanal",
        next_visiting_location: "Kodaikanal",
        itinerary_route_date: "2026-05-01T00:00:00+05:30",
        no_of_days: 4,
        no_of_km: 1,
        direct_to_next_visiting_place: 0,
        via_route: "",
        via_routes: []
      },
      {
        location_name: "Kodaikanal",
        next_visiting_location: "Madurai Airport",
        itinerary_route_date: "2026-05-02T00:00:00+05:30",
        no_of_days: 5,
        no_of_km: 133,
        direct_to_next_visiting_place: 0,
        via_route: "",
        via_routes: []
      }
    ],
    vehicles: [{ vehicle_type_id: 1, vehicle_count: 1 }],
    travellers: [{ room_id: 1, traveller_type: 1 }],
    previousDayBillingDecisionProvided: false,
    previousDayBillingConfirmed: false
  };

  const url = "http://127.0.0.1:4006/api/v1/itineraries/?type=itineary_basic_info_with_optimized_route";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  console.log("Status:", response.status);
  if (!response.ok) {
    console.log("Body:", data);
    process.exit(1);
  }

  const routes = data?.routes || [];
  console.log("Saved route count:", routes.length);
  console.log("Saved routes:");
  for (const r of routes) {
    console.log(`Day ${r.no_of_days}: ${r.location_name} -> ${r.next_visiting_location} (${r.itinerary_route_date})`);
  }

  console.log("\nFull response:");
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error("Script failed:", err?.message || err);
  process.exit(1);
});
