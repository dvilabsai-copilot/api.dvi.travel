// Quick performance profiling script
// Add this to measure where time is spent

const markers: Record<string, number> = {};

export function startMark(label: string) {
  markers[label] = Date.now();
 console.log(`[PERF] START: ${label}`);
}

export function endMark(label: string) {
  if (!markers[label]) {
 console.log(`[PERF] ERROR: No start mark for ${label}`);
    return;
  }
  const duration = Date.now() - markers[label];
 console.log(`[PERF] END: ${label} - ${duration}ms`);
  delete markers[label];
  return duration;
}
