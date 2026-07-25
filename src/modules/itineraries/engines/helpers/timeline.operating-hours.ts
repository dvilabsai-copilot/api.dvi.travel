// REPLACE-WHOLE-FILE
// FILE: src/modules/itineraries/engines/helpers/timeline.operating-hours.ts

import { timeToSeconds, secondsToTime } from "./time.helper";
import { TimeConverter } from "./time-converter";

type CheckResult = {
  canVisitNow: boolean;
  nextWindowStart: string | null;
  operatingHours?: string;
 adjustedStartTime?: string | null; // if arrived before open, shift start to open time
  reason?: string;
};

function toTimeString(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v instanceof Date) return TimeConverter.toTimeString(v);
  if (v && typeof v === "object" && typeof v.getUTCHours === "function") {
    const h = String(v.getUTCHours()).padStart(2, "0");
    const m = String(v.getUTCMinutes()).padStart(2, "0");
    const s = String(v.getUTCSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
  return null;
}

export class OperatingHoursChecker {
  check(
    timingMap: Map<number, Map<number, any[]>>,
    hotspotId: number,
    routeDate: Date,
    arrivalTime: string,
    visitEndTime: string,
  ): CheckResult {
    const visitStartSeconds = timeToSeconds(arrivalTime);
    const visitEndSeconds = timeToSeconds(visitEndTime);

 // Safety: bad input
    if (!Number.isFinite(visitStartSeconds) || !Number.isFinite(visitEndSeconds) || visitEndSeconds < visitStartSeconds) {
      return {
        canVisitNow: true,
        nextWindowStart: null,
        adjustedStartTime: null,
        reason: "Invalid visit time range (skipping hours enforcement)",
      };
    }

 // DB day might be stored either:
 // - Mon=0..Sun=6 (your previous logic)
 // - Sun=0..Sat=6 (native JS getDay)
 const dayMon0 = (routeDate.getDay() + 6) % 7; // Mon=0
 const daySun0 = routeDate.getDay(); // Sun=0

    const byHotspot = timingMap.get(hotspotId);
    const recsA = byHotspot?.get(dayMon0) || [];
    const recsB = byHotspot?.get(daySun0) || [];

 // merge unique by timing id if exists, else by start/end/flags
    const merged: any[] = [];
    const seen = new Set<string>();

    for (const r of [...recsA, ...recsB]) {
      const key = String(
        (r?.hotspot_timing_ID ?? "") +
          "|" +
          (r?.hotspot_open_all_time ?? "") +
          "|" +
          (r?.hotspot_closed ?? "") +
          "|" +
          (toTimeString(r?.hotspot_start_time) ?? "") +
          "|" +
          (toTimeString(r?.hotspot_end_time) ?? ""),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }

 // Hotspots without configured timing rows should not be auto-scheduled.
    if (!merged.length) {
      return {
        canVisitNow: false,
        nextWindowStart: null,
        adjustedStartTime: null,
        reason: "No timing rows configured",
      };
    }

 // Sort windows by start time (stable selection)
    merged.sort((a, b) => {
      const as = timeToSeconds(toTimeString(a?.hotspot_start_time) || "00:00:00");
      const bs = timeToSeconds(toTimeString(b?.hotspot_start_time) || "00:00:00");
      return as - bs;
    });

    let nextWindowStart: string | null = null;
    const allWindows: string[] = [];

    for (const timing of merged) {
      const isClosed = Number(timing?.hotspot_closed || 0) === 1;
      const openAllTime = Number(timing?.hotspot_open_all_time || 0) === 1;

      if (isClosed) {
 // Closed for that day (ignore this window)
        continue;
      }

      if (openAllTime) {
 // Open all day, ignore start/end
        allWindows.push("Open 24h");
        return {
          canVisitNow: true,
          nextWindowStart: null,
          adjustedStartTime: null,
          operatingHours: allWindows.join(", "),
        };
      }

      const operatingStart = toTimeString(timing?.hotspot_start_time);
      const operatingEnd = toTimeString(timing?.hotspot_end_time);

      if (!operatingStart || !operatingEnd) {
 // Invalid / incomplete row
        continue;
      }

      const opStartSeconds = timeToSeconds(operatingStart);
      const opEndSeconds = timeToSeconds(operatingEnd);

 // IMPORTANT: ignore broken windows like 21:00 -> 18:00 (your data has this)
      if (!Number.isFinite(opStartSeconds) || !Number.isFinite(opEndSeconds) || opEndSeconds <= opStartSeconds) {
        continue;
      }

      allWindows.push(`${operatingStart}-${operatingEnd}`);

 const MAX_WAIT_SECONDS = 30 * 60; // Parity: Only "wait" if gap is < 30 mins. Else defer to Pass 2.

 // Case 1: Arrived before opening. If visit can fit fully inside window, "wait" until open.
      if (visitStartSeconds < opStartSeconds) {
        const durationSec = visitEndSeconds - visitStartSeconds;
        const shiftedEnd = opStartSeconds + durationSec;
        const waitTimeSeconds = opStartSeconds - visitStartSeconds;

        if (shiftedEnd <= opEndSeconds && waitTimeSeconds <= MAX_WAIT_SECONDS) {
          return {
            canVisitNow: true,
            nextWindowStart: null,
            adjustedStartTime: operatingStart,
            operatingHours: allWindows.join(", "),
          };
        }

 // Otherwise record possible next window (earliest after arrival) for deferral
        if (nextWindowStart === null || opStartSeconds < timeToSeconds(nextWindowStart)) {
          nextWindowStart = operatingStart;
        }
        continue;
      }

 // Case 2: Arrived within open window, and visit finishes before closing => OK
      if (visitStartSeconds >= opStartSeconds && visitStartSeconds < opEndSeconds) {
        if (visitEndSeconds <= opEndSeconds) {
          return {
            canVisitNow: true,
            nextWindowStart: null,
            adjustedStartTime: null,
            operatingHours: allWindows.join(", "),
          };
        }
      }

 // Case 3: Arrived after this window start; look for later windows
      if (opStartSeconds > visitStartSeconds) {
        if (nextWindowStart === null || opStartSeconds < timeToSeconds(nextWindowStart)) {
          nextWindowStart = operatingStart;
        }
      }
    }

    return {
      canVisitNow: false,
      nextWindowStart,
      operatingHours: allWindows.join(", "),
      adjustedStartTime: null,
      reason: "No valid operating window for this visit time",
    };
  }
}
