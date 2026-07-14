export type VehicleRateType = 'Local' | 'Outstation';

export type VehicleRateAvailability = {
  available: boolean;
  missingRateTypes: VehicleRateType[];
};

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * A vehicle detail row is rate-bearing when it has a route distance. A zero
 * rental on a rate-bearing local/outstation row means that the applicable
 * pricebook rate was not found. Zero-distance rows are intentionally ignored
 * because the vehicle engine preserves those rows for display purposes.
 */
export function getVehicleRateAvailability(rows: any[]): VehicleRateAvailability {
  const missingRateTypes = new Set<VehicleRateType>();
  const detailRows = Array.isArray(rows) ? rows : [];

  if (detailRows.length === 0) {
    return {
      available: false,
      missingRateTypes: ['Local', 'Outstation'],
    };
  }

  for (const row of detailRows) {
    const travelType = toNumber(row?.travel_type);
    if (travelType !== 1 && travelType !== 2) continue;

    const totalKm =
      toNumber(row?.total_pickup_km) +
      toNumber(row?.total_running_km) +
      toNumber(row?.total_siteseeing_km) +
      toNumber(row?.total_drop_km);

    if (totalKm <= 0 || toNumber(row?.vehicle_rental_charges) > 0) continue;

    missingRateTypes.add(travelType === 1 ? 'Local' : 'Outstation');
  }

  return {
    available: missingRateTypes.size === 0,
    missingRateTypes: Array.from(missingRateTypes),
  };
}

export function buildVehicleRateAvailabilityMessage(
  vendorNames: string[],
  vehicleTypeName?: string | null,
  missingRateTypes: VehicleRateType[] = [],
): string {
  const names = Array.from(
    new Set(vendorNames.map((name) => String(name || '').trim()).filter(Boolean)),
  );
  const vehicleLabel = String(vehicleTypeName || 'this vehicle type').trim();
  const rateNames = (['Local', 'Outstation'] as VehicleRateType[])
    .filter((type) => missingRateTypes.includes(type))
    .map((type) => type.toLowerCase());
  const rateTypeLabel = rateNames.length === 2
    ? 'local and outstation'
    : rateNames[0] || 'local or outstation';
  const rateLabel = rateNames.length
    ? `applicable ${rateTypeLabel} rates`
    : 'applicable local or outstation rates';

  if (names.length === 1) {
    return `Vendor ${names[0]} does not have ${rateLabel} for ${vehicleLabel}.`;
  }

  return `No vendors have ${rateLabel} for ${vehicleLabel}.`;
}
