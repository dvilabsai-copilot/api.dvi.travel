type RoomNightEntry = Record<string, unknown>;

/**
 * Treat a browser-carried breakdown as presentation metadata only. It is
 * accepted only when its room-night rows reconcile to the supplier's current
 * aggregate fare; callers must also establish that the exact rate identity
 * was resolved by the server.
 */
export function getValidatedTboRoomNightBreakdownForDate(
  breakdown: unknown,
  authoritativeFare: unknown,
  routeDate: string,
): RoomNightEntry[] | undefined {
  if (!Array.isArray(breakdown) || breakdown.length === 0) return undefined;
  const fare = Number(authoritativeFare);
  if (!Number.isFinite(fare) || fare < 0) return undefined;

  const rows = breakdown as RoomNightEntry[];
  const valid = rows.every((row) => {
    const date = String(row?.date || '').slice(0, 10);
    const roomNumber = Number(row?.roomNumber);
    const amount = Number(row?.allInAmount);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isInteger(roomNumber) && roomNumber > 0 &&
      Number.isFinite(amount) && amount >= 0;
  });
  if (!valid) return undefined;

  const aggregateCents = rows.reduce(
    (sum, row) => sum + Math.round(Number(row.allInAmount) * 100),
    0,
  );
  if (Math.abs(aggregateCents - Math.round(fare * 100)) > 1) return undefined;

  const scoped = rows.filter((row) => String(row.date).slice(0, 10) === routeDate);
  return scoped.length > 0 ? scoped : undefined;
}
