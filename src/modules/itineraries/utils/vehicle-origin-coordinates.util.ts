type CoordinatePair = { latitude: number; longitude: number };

function validPair(latitude: unknown, longitude: unknown): CoordinatePair | null {
  if (latitude == null || longitude == null || String(latitude).trim() === '' || String(longitude).trim() === '') return null;
  const lat = Number(latitude), lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { latitude: lat, longitude: lng };
}

export function resolveVehicleOriginCoordinates(
  vehicle: { vehicle_origin_latitude?: unknown; vehicle_origin_longitude?: unknown },
  vendor: { vendor_origin_latitude?: unknown; vendor_origin_longitude?: unknown } | null,
  fallback: CoordinatePair,
): CoordinatePair {
  return validPair(vehicle.vehicle_origin_latitude, vehicle.vehicle_origin_longitude)
    ?? validPair(vendor?.vendor_origin_latitude, vendor?.vendor_origin_longitude)
    ?? fallback;
}
