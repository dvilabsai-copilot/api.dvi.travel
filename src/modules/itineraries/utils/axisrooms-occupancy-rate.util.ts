/** Covering ARI rows are versioned by receipt; effective start breaks ties. */
export const compareAxisRoomsOccupancyRows = (left: any, right: any): number => {
  const time = (value: unknown) => {
    const parsed = value ? new Date(String(value)).getTime() : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return time(right?.received_at) - time(left?.received_at) ||
    time(right?.start_date) - time(left?.start_date);
};

export function axisRoomsOccupancyValues(row: any): Record<string, any> {
  try {
    const values = typeof row?.occupancy_rates === 'string' ? JSON.parse(row.occupancy_rates) : row?.occupancy_rates;
    return values && typeof values === 'object' && !Array.isArray(values) ? values : {};
  } catch { return {}; }
}

/** A supplement-only historical row cannot supply a room or its supplements. */
export function latestAxisRoomsOccupancyValues(rows: any[], occupancy: 'SINGLE' | 'DOUBLE'): Record<string, any> | null {
  for (const row of [...(Array.isArray(rows) ? rows : [])].sort(compareAxisRoomsOccupancyRows)) {
    const values = axisRoomsOccupancyValues(row);
    if (Number.isFinite(Number(values[occupancy])) && Number(values[occupancy]) > 0) return values;
  }
  return null;
}
