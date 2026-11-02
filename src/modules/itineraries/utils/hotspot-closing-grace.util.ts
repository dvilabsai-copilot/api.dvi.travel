export function getHotspotClosingGraceMinutes(
  startMinutes: number,
  endMinutes: number,
): number {
  const normalizedEndMinutes = endMinutes < startMinutes ? endMinutes + (24 * 60) : endMinutes;
  const durationMinutes = normalizedEndMinutes - startMinutes;

  return durationMinutes > 4 * 60 ? 30 : 0;
}
