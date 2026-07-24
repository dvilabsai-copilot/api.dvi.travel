export class CacheUpdateDto {
  id!: number;
  haversineKm?: number;
  correctionFactor?: number;
  distanceKm?: number;
  speedKmph?: number;
 travelTime?: string; // HH:MM:SS
  method?: string;
}
