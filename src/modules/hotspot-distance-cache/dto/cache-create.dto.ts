export class CacheCreateDto {
  fromHotspotId!: number;
  toHotspotId!: number;
  travelLocationType: number = 1;
  haversineKm!: number;
  correctionFactor: number = 1.5;
  distanceKm!: number;
  speedKmph!: number;
 travelTime!: string; // HH:MM:SS
  method?: string = 'HAVERSINE';
}
