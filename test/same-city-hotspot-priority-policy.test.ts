import assert from "node:assert/strict";
import {
  buildSameCityCapacityAllocation,
  buildSameCityPoolDiagnostics,
  buildSameCityRoutePolicyContexts,
  calculateSameCityPriorityLimit,
  findSameCityPolicyViolations,
  filterSameCityAutomaticCandidates,
  shouldDeferSameCityAutomaticCandidate,
} from "../src/modules/itineraries/engines/helpers/same-city-hotspot-priority-policy";
import { TimelineRoutePolicyService } from "../src/modules/itineraries/engines/helpers/timeline-route-policy.service";

const cityKey = (value: string): string => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const matchesCity = (location: string, city: string): boolean => cityKey(location).includes(cityKey(city));

const main = (): void => {
  const expected = [
    [10, 3, 6, 10],
    [15, 5, 10, 15],
    [20, 6, 12, 20],
    [25, 8, 16, 25],
    [30, 10, 20, 30],
    [40, 10, 20, 30],
  ] as const;

  for (const [poolCount, day1, day2, day3] of expected) {
    assert.equal(calculateSameCityPriorityLimit(poolCount, 30, 10, 1).limit, day1);
    assert.equal(calculateSameCityPriorityLimit(poolCount, 30, 10, 2).limit, day2);
    assert.equal(calculateSameCityPriorityLimit(poolCount, 30, 10, 3).limit, day3);
  }

  assert.equal(calculateSameCityPriorityLimit(0, 30, 10, 1).limit, 0);
  assert.equal(calculateSameCityPriorityLimit(1, 30, 10, 1).limit, 1);
  assert.equal(calculateSameCityPriorityLimit(2, 30, 10, 1).limit, 1);

  assert.deepEqual(
    buildSameCityCapacityAllocation({
      candidateCount: 12,
      effectiveCount: 15,
      estimatedCapacity: 3,
      currentDayLimit: 5,
    }),
    { estimatedCapacity: 3, softTarget: 3, reserveForFutureDays: 12 },
    "capacity reduces the soft daily target without changing the unlocked priority ceiling",
  );
  assert.deepEqual(
    buildSameCityCapacityAllocation({
      candidateCount: 15,
      effectiveCount: 15,
      estimatedCapacity: 8,
      currentDayLimit: 10,
      futureCapacity: 10,
    }),
    { estimatedCapacity: 8, softTarget: 5, reserveForFutureDays: 10 },
    "future route capacity reserves feasible attractions instead of exhausting the current day",
  );
  assert.deepEqual(
    buildSameCityCapacityAllocation({
      candidateCount: 15,
      effectiveCount: 15,
      estimatedCapacity: 8,
      currentDayLimit: 10,
      futureCapacity: 0,
    }),
    { estimatedCapacity: 8, softTarget: 8, reserveForFutureDays: 7 },
    "when future capacity is unavailable, the current day can use its own feasible capacity",
  );

  const contexts = buildSameCityRoutePolicyContexts(
    [
      { itinerary_route_ID: 1, itinerary_route_date: "2026-10-25", location_name: "Cochin International Airport", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 2, itinerary_route_date: "2026-10-26", location_name: "Munnar", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 3, itinerary_route_date: "2026-10-27", location_name: "Munnar", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 4, itinerary_route_date: "2026-10-28", location_name: "Munnar", next_visiting_location: "Thekkady" },
      { itinerary_route_ID: 5, itinerary_route_date: "2026-10-29", location_name: "Thekkady", next_visiting_location: "Thekkady" },
    ],
    cityKey,
  );

  assert.equal(contexts.get(1)?.cityDay, 1, "arrival route starts the continuous city stay at day 1");
  assert.equal(contexts.get(2)?.cityDay, 2, "same-city route increments city day");
  assert.equal(contexts.get(3)?.cityDay, 3, "same-city route increments city day");
  assert.equal(contexts.get(1)?.eligible, true, "arrival route is eligible when the city stay spans multiple days");
  assert.equal(contexts.get(2)?.eligible, true);
  assert.equal(contexts.get(4)?.eligible, false, "intercity movement is not a same-city sightseeing route");
  assert.equal(contexts.get(5)?.eligible, false, "single-day city group remains outside the policy");

  const sameDateContexts = buildSameCityRoutePolicyContexts(
    [
      { itinerary_route_ID: 10, itinerary_route_date: "2026-10-25", location_name: "Cochin International Airport", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 11, itinerary_route_date: "2026-10-25", location_name: "Munnar", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 12, itinerary_route_date: "2026-10-26", location_name: "Munnar", next_visiting_location: "Munnar" },
    ],
    cityKey,
  );
  assert.equal(sameDateContexts.get(10)?.cityDay, 1);
  assert.equal(sameDateContexts.get(11)?.cityDay, 1, "multiple route rows on one date share city day");
  assert.equal(sameDateContexts.get(12)?.cityDay, 2);

  const returnAfterCityContexts = buildSameCityRoutePolicyContexts(
    [
      { itinerary_route_ID: 20, itinerary_route_date: "2026-10-25", location_name: "Cochin International Airport", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 21, itinerary_route_date: "2026-10-26", location_name: "Munnar", next_visiting_location: "Thekkady" },
      { itinerary_route_ID: 22, itinerary_route_date: "2026-10-27", location_name: "Thekkady", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 23, itinerary_route_date: "2026-10-28", location_name: "Munnar", next_visiting_location: "Munnar" },
      { itinerary_route_ID: 24, itinerary_route_date: "2026-10-29", location_name: "Munnar", next_visiting_location: "Munnar" },
    ],
    cityKey,
  );
  assert.equal(returnAfterCityContexts.get(22)?.eligible, false, "intercity movement remains outside the same-city policy");
  assert.equal(returnAfterCityContexts.get(23)?.cityDay, 1, "the first local route after returning starts a fresh city stay");
  assert.equal(returnAfterCityContexts.get(23)?.eligible, true);

  const pool = Array.from({ length: 5 }, (_, index) => ({
    hotspot_ID: index + 1,
    hotspot_location: "Munnar",
    hotspot_to_location: "Munnar",
    hotspot_priority: index + 1,
    status: 1,
    deleted: 0,
  }));
  const diagnostics = buildSameCityPoolDiagnostics("munnar", [...pool, { ...pool[0], hotspot_ID: 6 }], 5);
  assert.deepEqual(diagnostics.duplicatePriorities, [1]);
  assert.deepEqual(diagnostics.missingPriorities, []);
  const invalidPriorityDiagnostics = buildSameCityPoolDiagnostics(
    "munnar",
    [...pool, { ...pool[0], hotspot_ID: 7, hotspot_priority: 16 }],
    5,
  );
  assert.deepEqual(invalidPriorityDiagnostics.invalidPriorityIds, [7], "priority 16 is invalid in a five-record effective pool");
  const context = contexts.get(1)!;

  const routeOnlyPoolDiagnostics = filterSameCityAutomaticCandidates({
    candidates: [],
    allHotspots: [
      ...pool,
      { ...pool[0], hotspot_ID: 8, hotspot_priority: 6 },
    ],
    context,
    config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    estimatedCapacity: 5,
    routeOnlyHotspotIds: new Set([8]),
    hotspotLocationMatchesCity: matchesCity,
  });
  assert.equal(routeOnlyPoolDiagnostics.diagnostics.poolCount, 5, "via-only records do not inflate the local city pool");

  assert.equal(
    shouldDeferSameCityAutomaticCandidate({
      candidate: pool[0],
      context,
      config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
      scheduledCount: 2,
      softTarget: 2,
      isLocalCandidate: true,
    }),
    true,
    "same-city automatic scheduling stops at the computed soft target",
  );
  assert.equal(
    shouldDeferSameCityAutomaticCandidate({
      candidate: { ...pool[0], isManualSelection: true },
      context,
      config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
      scheduledCount: 2,
      softTarget: 2,
      isLocalCandidate: true,
    }),
    false,
    "manual hotspots bypass the automatic capacity target",
  );

  const result = filterSameCityAutomaticCandidates({
    candidates: [
      { ...pool[0], matched_bucket: "destination" },
      { ...pool[4], matched_bucket: "destination" },
      { ...pool[0], hotspot_ID: 99, hotspot_priority: 99, isManualSelection: true, matched_bucket: "destination" },
      { ...pool[4], hotspot_ID: 100, hotspot_priority: 5, matched_bucket: "en_route" },
    ],
    allHotspots: pool,
    context,
    config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    estimatedCapacity: 5,
    hotspotLocationMatchesCity: matchesCity,
  });

  assert.deepEqual(result.candidates.map((candidate) => Number(candidate.hotspot_ID)), [1, 99, 100]);
  assert.deepEqual(result.removed.map((candidate) => Number(candidate.hotspot_ID)), [5]);

  const disabled = filterSameCityAutomaticCandidates({
    candidates: [{ ...pool[4], matched_bucket: "destination" }],
    allHotspots: pool,
    context,
    config: { enabled: false, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    hotspotLocationMatchesCity: matchesCity,
  });
  assert.equal(disabled.candidates.length, 1, "disabled policy preserves legacy selection");

  const violations = findSameCityPolicyViolations({
    rows: [
      { item_type: 4, itinerary_route_ID: 1, hotspot_ID: 5, hotspot_priority: 5, hotspot_plan_own_way: 0 },
      { item_type: 4, itinerary_route_ID: 1, hotspot_ID: 99, hotspot_priority: 99, hotspot_plan_own_way: 1 },
    ],
    allHotspots: pool,
    contexts,
    config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    hotspotLocationMatchesCity: matchesCity,
  });
  assert.deepEqual(
    violations.map((violation) => violation.hotspotId),
    [5],
    "final validation rejects automatic rows but preserves manual rows",
  );

  const routeOnlyValidation = findSameCityPolicyViolations({
    rows: [
      { item_type: 4, itinerary_route_ID: 1, hotspot_ID: 8, hotspot_priority: 5, matched_bucket: "corridor", hotspot_plan_own_way: 0 },
    ],
    allHotspots: [
      ...pool,
      { ...pool[0], hotspot_ID: 8, hotspot_priority: 5 },
    ],
    contexts,
    config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    routeOnlyHotspotIds: new Set([8]),
    hotspotLocationMatchesCity: matchesCity,
  });
  assert.deepEqual(
    routeOnlyValidation,
    [],
    "final validation ignores explicitly route-only hotspots",
  );

  const capacityLimited = filterSameCityAutomaticCandidates({
    candidates: [
      { ...pool[0], matched_bucket: "destination" },
      { ...pool[1], matched_bucket: "destination" },
      { ...pool[2], matched_bucket: "destination" },
      { ...pool[3], matched_bucket: "destination" },
      { ...pool[4], matched_bucket: "destination" },
      { ...pool[4], hotspot_ID: 100, hotspot_priority: 25, isManualSelection: true, matched_bucket: "destination" },
      { ...pool[4], hotspot_ID: 101, hotspot_priority: 5, matched_bucket: "en_route" },
    ],
    allHotspots: pool,
    context,
    config: { enabled: true, maxPriority: 5, baseIncrement: 2, distributionMode: "BALANCED" },
    estimatedCapacity: 2,
    hotspotLocationMatchesCity: matchesCity,
  });
  assert.deepEqual(
    capacityLimited.candidates.map((candidate) => Number(candidate.hotspot_ID)),
    [1, 2, 100, 101],
    "capacity remains a soft target so the real feasibility scheduler can fall through to the next unlocked candidate",
  );
  assert.deepEqual(
    capacityLimited.removed.map((candidate) => Number(candidate.hotspot_ID)),
    [3, 4, 5],
    "only candidates outside the unlocked priority range are removed",
  );

  const routePolicy = new TimelineRoutePolicyService();
  assert.equal(
    routePolicy.estimateRouteHotspotCapacity({
      capacity_start_seconds: 9 * 3600,
      capacity_end_seconds: 18 * 3600,
      capacity_busy_intervals: [
        { start_seconds: 9 * 3600, end_seconds: 10 * 3600 },
        { start_seconds: 13 * 3600, end_seconds: 14 * 3600 },
      ],
      capacity_candidate_durations_seconds: [3600, 3600],
      capacity_travel_buffer_seconds: 1800,
    }),
    4,
    "capacity uses the effective sightseeing window, fixed timeline rows and candidate duration/travel inputs",
  );
  assert.equal(
    routePolicy.estimateRouteHotspotCapacity({
      capacity_start_seconds: 9 * 3600,
      capacity_end_seconds: 18 * 3600,
      capacity_suppressed: true,
    }),
    0,
    "late-arrival suppression leaves no automatic capacity",
  );
};

main();
console.log("same-city hotspot priority policy tests passed");
