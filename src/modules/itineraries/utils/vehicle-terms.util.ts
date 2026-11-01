export type VehicleTermsPlanSource = {
  vehicle_terms_condition?: string | null;
};

export type VehicleTermsSettingsSource = {
  vehicleTermsCondition?: string | null;
};

/** Resolve the customer-facing vehicle terms without changing vehicle pricing. */
export function resolveVehicleTermsCondition({
  itineraryPreference,
  plan,
  globalSettings,
}: {
  itineraryPreference: number | null | undefined;
  plan?: unknown;
  globalSettings?: VehicleTermsSettingsSource | null;
}): string {
  const preference = Number(itineraryPreference || 0);
  if (preference !== 2 && preference !== 3) return "";

  const itineraryTerms = String(
    plan && typeof plan === "object" && "vehicle_terms_condition" in plan
      ? (plan as VehicleTermsPlanSource).vehicle_terms_condition
      : "",
  ).trim();
  if (itineraryTerms) return itineraryTerms;

  return String(globalSettings?.vehicleTermsCondition ?? "").trim();
}
