export type EntryTicketTravellerType = 'adult' | 'child' | 'infant';

export interface EntryTicketTravellerBreakdownDto {
  type: EntryTicketTravellerType;
  label: string;
  quantity: number;
  unitCost: number;
  total: number;
}

export interface EntryTicketBreakdownDto {
  dayNumber: number;
  date: string | null;
  locationId: number;
  hotspotId: number;
  routeHotspotId: number;
  locationName: string;
  total: number;
  entryTicketRequired: boolean;
  nationality: number;
  travellers: EntryTicketTravellerBreakdownDto[];
}

type PersistedEntryTicketRow = {
  traveller_type?: number | null;
  entry_ticket_cost?: number | null;
};

const TRAVELLER_META: Record<number, { type: EntryTicketTravellerType; label: string }> = {
  1: { type: 'adult', label: 'Adult' },
  2: { type: 'child', label: 'Child' },
  3: { type: 'infant', label: 'Infant' },
};

const roundCurrency = (value: number): number =>
  Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const buildFallbackTravellerRows = (params: {
  routeHotspot: any;
  adults: number;
  children: number;
  infants: number;
  nationality: number;
  entryTicketRequired: boolean;
}): EntryTicketTravellerBreakdownDto[] => {
  if (!params.entryTicketRequired) return [];

  const isDomestic = Number(params.nationality || 0) === 101;
  const rates = isDomestic
    ? [
        { type: 'adult' as const, label: 'Adult', quantity: params.adults, unitCost: Number(params.routeHotspot?.hotspot_adult_entry_cost || 0) },
        { type: 'child' as const, label: 'Child', quantity: params.children, unitCost: Number(params.routeHotspot?.hotspot_child_entry_cost || 0) },
        { type: 'infant' as const, label: 'Infant', quantity: params.infants, unitCost: Number(params.routeHotspot?.hotspot_infant_entry_cost || 0) },
      ]
    : [
        { type: 'adult' as const, label: 'Adult', quantity: params.adults, unitCost: Number(params.routeHotspot?.hotspot_foreign_adult_entry_cost || 0) },
        { type: 'child' as const, label: 'Child', quantity: params.children, unitCost: Number(params.routeHotspot?.hotspot_foreign_child_entry_cost || 0) },
        { type: 'infant' as const, label: 'Infant', quantity: params.infants, unitCost: Number(params.routeHotspot?.hotspot_foreign_infant_entry_cost || 0) },
      ];

  return rates
    .filter((row) => row.quantity > 0 && row.unitCost > 0)
    .map((row) => ({
      ...row,
      total: roundCurrency(row.quantity * row.unitCost),
    }));
};

export function buildEntryTicketBreakdown(params: {
  dayNumber: number;
  date: Date | string | null | undefined;
  locationId: number;
  locationName: string;
  routeHotspot: any;
  persistedRows?: PersistedEntryTicketRow[];
  adults: number;
  children: number;
  infants: number;
  nationality: number;
  entryTicketRequired: boolean;
}): EntryTicketBreakdownDto | null {
  const persistedRows = (Array.isArray(params.persistedRows) ? params.persistedRows : [])
    .filter((row) => Number(row.entry_ticket_cost || 0) > 0);
  const grouped = new Map<number, EntryTicketTravellerBreakdownDto>();

  for (const row of persistedRows) {
    const travellerType = Number(row.traveller_type || 0);
    const meta = TRAVELLER_META[travellerType];
    const unitCost = Number(row.entry_ticket_cost || 0);
    if (!meta || !Number.isFinite(unitCost) || unitCost <= 0) continue;

    const existing = grouped.get(travellerType);
    if (existing) {
      existing.quantity += 1;
      existing.total = roundCurrency(existing.total + unitCost);
    } else {
      grouped.set(travellerType, {
        type: meta.type,
        label: meta.label,
        quantity: 1,
        unitCost: roundCurrency(unitCost),
        total: roundCurrency(unitCost),
      });
    }
  }

  const travellers = grouped.size > 0
    ? Array.from(grouped.values())
    : buildFallbackTravellerRows(params);
  const total = roundCurrency(travellers.reduce((sum, row) => sum + row.total, 0));

  if (total <= 0 && travellers.length === 0) return null;

  return {
    dayNumber: params.dayNumber,
    date: params.date instanceof Date
      ? params.date.toISOString().slice(0, 10)
      : (params.date ? String(params.date).slice(0, 10) : null),
    locationId: Number(params.routeHotspot?.hotspot_ID || params.locationId || 0),
    hotspotId: Number(params.routeHotspot?.hotspot_ID || 0),
    routeHotspotId: Number(params.routeHotspot?.route_hotspot_ID || 0),
    locationName: String(params.locationName || 'Sightseeing Location').trim() || 'Sightseeing Location',
    total,
    entryTicketRequired: params.entryTicketRequired,
    nationality: Number(params.nationality || 0),
    travellers,
  };
}
