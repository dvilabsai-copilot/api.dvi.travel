import assert from "node:assert/strict";
import test from "node:test";
import { resolveVehicleTermsCondition } from "../src/modules/itineraries/utils/vehicle-terms.util";

test("vehicle itinerary terms prefer itinerary-specific content", () => {
  assert.equal(
    resolveVehicleTermsCondition({
      itineraryPreference: 3,
      plan: { vehicle_terms_condition: " itinerary terms " },
      globalSettings: { vehicleTermsCondition: "global terms" },
    }),
    "itinerary terms",
  );
});

test("vehicle itinerary terms fall back to global settings", () => {
  assert.equal(
    resolveVehicleTermsCondition({
      itineraryPreference: 2,
      plan: { vehicle_terms_condition: "" },
      globalSettings: { vehicleTermsCondition: " global terms " },
    }),
    "global terms",
  );
});

test("hotel-only itineraries do not receive vehicle terms", () => {
  assert.equal(
    resolveVehicleTermsCondition({
      itineraryPreference: 1,
      globalSettings: { vehicleTermsCondition: "global terms" },
    }),
    "",
  );
});
