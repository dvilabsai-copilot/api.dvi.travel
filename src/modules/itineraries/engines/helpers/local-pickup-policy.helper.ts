export function shouldSuppressSyntheticLocalPickup(input: {
  travelType: number;
  routeCount: number;
  isSameVehicleOriginCity: boolean;
  localPointSource: string;
  hasSelectedHotel: boolean;
}): boolean {
  return (
    input.travelType === 1 &&
    input.routeCount > 1 &&
    input.isSameVehicleOriginCity &&
    input.localPointSource === 'city_fallback' &&
    !input.hasSelectedHotel
  );
}
