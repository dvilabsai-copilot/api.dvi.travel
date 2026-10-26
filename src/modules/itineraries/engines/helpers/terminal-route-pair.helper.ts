export function findTerminalTravelAndOvernightRows(
  rows: any[],
  lastVisitEnd: number,
): { finalTravel: any; overnight: any } | null {
  const timestamp = (value: any): number =>
    value ? new Date(value).getTime() : NaN;

  if (!Number.isFinite(lastVisitEnd)) {
    return null;
  }

  const terminalTravels = rows.filter((row: any) => {
    if (Number(row?.item_type) !== 5) {
      return false;
    }

    const start = timestamp(row?.hotspot_start_time);
    const end = timestamp(row?.hotspot_end_time);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start >= lastVisitEnd &&
      end > start
    );
  });

  if (terminalTravels.length !== 1) {
    return null;
  }

  const finalTravel = terminalTravels[0];
  const finalArrival = timestamp(finalTravel.hotspot_end_time);
  const overnightMarkers = rows.filter((row: any) => {
    if (Number(row?.item_type) !== 6) {
      return false;
    }

    return (
      timestamp(row?.hotspot_start_time) === finalArrival &&
      timestamp(row?.hotspot_end_time) === finalArrival
    );
  });

  if (overnightMarkers.length !== 1) {
    return null;
  }

  return { finalTravel, overnight: overnightMarkers[0] };
}
