import { Injectable } from '@nestjs/common';

export type CoordinatePair = { latitude: number; longitude: number };
export type CoordinateInput = { latitude: number | null; longitude: number | null };

@Injectable()
export class LocationGeoPolicyService {
  parseCoordinatePair(value: unknown): CoordinatePair | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const match = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return { latitude, longitude };
  }

  resolveCoordinateInput(latitudeValue: unknown, longitudeValue: unknown): CoordinateInput {
    const combinedFromLatitude = this.parseCoordinatePair(latitudeValue);
    if (combinedFromLatitude) return combinedFromLatitude;
    const combinedFromLongitude = this.parseCoordinatePair(longitudeValue);
    if (combinedFromLongitude) return combinedFromLongitude;
    return { latitude: this.toCoordinate(latitudeValue), longitude: this.toCoordinate(longitudeValue) };
  }

  toCoordinate(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  normalizeLocationName(value: unknown): string {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
  }

  uniqueStringsCaseInsensitive(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(text);
    }
    return result;
  }

  estimateDurationText(distanceKm: number): string {
    const totalHours = distanceKm / 25;
    let hours = Math.floor(totalHours);
    let mins = Math.round((totalHours - hours) * 60);
    if (mins === 60) {
      hours += 1;
      mins = 0;
    }
    return `${hours} hours ${mins} mins`;
  }

  calculateDistanceKm(sourceLat: number, sourceLng: number, destLat: number, destLng: number): number {
    const toRadians = (value: number) => (value * Math.PI) / 180;
    const dLat = toRadians(destLat - sourceLat);
    const dLng = toRadians(destLng - sourceLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(sourceLat)) *
        Math.cos(toRadians(destLat)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((6371 * c).toFixed(6));
  }
}
