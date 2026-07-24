// REPLACE-WHOLE-FILE
// FILE: src/itineraries/utils/time-utils.ts

export function toHMS(h: number, m = 0, s = 0) {
  const z = (n: number) => String(Math.max(0, n | 0)).padStart(2, "0");
  return `${z(h)}:${z(m)}:${z(s)}`;
}

export function toSeconds(hms: string) {
  const [h, m, s] = (hms || "00:00:00").split(":").map((x) => Number(x || 0));
  return (h | 0) * 3600 + (m | 0) * 60 + (s | 0);
}

export function secondsToHMS(sec: number) {
  const S = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(S / 3600);
  const m = Math.floor((S % 3600) / 60);
  const s = S % 60;
  return toHMS(h, m, s);
}

export function addHMS(base: string, add: string) {
  const b = toSeconds(base);
  const a = toSeconds(add);
  return secondsToHMS(b + a);
}

export function subHMS(base: string, sub: string) {
  const b = toSeconds(base);
  const a = toSeconds(sub);
  return secondsToHMS(Math.max(0, b - a));
}

export function toISTDateTime(dateStr: string, timeStr: string): string {
 // dateStr: "10/12/2025"
 // timeStr: "11:00 AM"

  const [dd, mm, yyyy] = dateStr.split("/").map(Number);

  let [time, meridian] = timeStr.split(" ");
  let [hh, min] = time.split(":").map(Number);

  if (meridian === "PM" && hh < 12) hh += 12;
  if (meridian === "AM" && hh === 12) hh = 0;

  const pad = (n: number) => String(n).padStart(2, "0");

  return `${yyyy}-${pad(mm)}-${pad(dd)} ${pad(hh)}:${pad(min)}:00`;
}
