/** Rebuild only a stale final journey after the manual attraction chain moved. */
export async function repairStaleManualTerminalTravel(
  rows: any[], buildFinalTravel: (lastVisit: any, previousTravel: any) => Promise<any>,
): Promise<boolean> {
  const time = (value: any) => value ? new Date(value).getTime() : NaN;
  const visits = rows.filter(r => Number(r.item_type) === 4);
  const travels = rows.filter(r => Number(r.item_type) === 5);
  const markers = rows.filter(r => Number(r.item_type) === 6);
  if (!visits.length || travels.length !== 1 || markers.length !== 1) return false;
  const lastVisit = [...visits].sort((a,b) => time(b.hotspot_end_time) - time(a.hotspot_end_time))[0];
  const end = time(lastVisit.hotspot_end_time);
  const start = time(travels[0].hotspot_start_time);
  const arrival = time(markers[0].hotspot_start_time);
  if (![end,start,arrival].every(Number.isFinite) || start >= end || arrival < end) return false;
  const rebuilt = await buildFinalTravel(lastVisit, travels[0]);
  const finalStart = time(rebuilt.hotspot_start_time);
  const finalEnd = time(rebuilt.hotspot_end_time);
  if (!Number.isFinite(finalEnd) || finalStart < end || finalEnd <= finalStart) {
    throw new Error('Invalid rebuilt manual terminal journey');
  }
  Object.assign(travels[0], rebuilt);
  markers[0].hotspot_start_time = new Date(finalEnd);
  markers[0].hotspot_end_time = new Date(finalEnd);
  return true;
}
