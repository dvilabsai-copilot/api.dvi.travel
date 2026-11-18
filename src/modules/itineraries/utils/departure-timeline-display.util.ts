/** A departure transfer is already visible; do not invent a breakfast gap. */
export function shouldOmitSyntheticDepartureStart(input: {
  routeIndex: number;
  routeCount: number;
  rows: Array<{ item_type?: number | string | null }>;
}): boolean {
  return input.routeIndex === input.routeCount - 1 &&
    input.rows.some(row => Number(row.item_type) === 7) &&
    !input.rows.some(row => [1, 4].includes(Number(row.item_type)));
}
