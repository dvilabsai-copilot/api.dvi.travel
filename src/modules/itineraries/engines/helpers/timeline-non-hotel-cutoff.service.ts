import { Prisma } from '@prisma/client';
import { DistanceHelper } from './distance.helper';
import { timeToSeconds } from './time.helper';

type Tx = Prisma.TransactionClient;

export interface TimelineNonHotelCutoffCallbacks {
  canonicalCityKey: (value: string) => string;
}

export class TimelineNonHotelCutoffService {
  private callbacks!: TimelineNonHotelCutoffCallbacks;

  constructor(private readonly distanceHelper: DistanceHelper = new DistanceHelper()) {}

  setCallbacks(callbacks: TimelineNonHotelCutoffCallbacks): void {
    this.callbacks = callbacks;
  }

  async calculate(input: {
    tx: Tx;
    route: any;
    isLastRoute: boolean;
    routeEndSeconds: number;
    routeEndTime: string;
    sourceCity: string;
    destinationCity: string;
    destCityCoords?: { lat: number; lon: number };
  }): Promise<{ latestNonHotelEndSeconds: number; latestNonHotelEndTime: string }> {
    let latestNonHotelEndSeconds = input.routeEndSeconds;
    let latestNonHotelEndTime = input.routeEndTime;
    const directToNext = Number(input.route?.direct_to_next_visiting_place || 0);
    const sourceKey = this.callbacks.canonicalCityKey(
      String(input.sourceCity || input.route?.location_name || ''),
    );
    const destinationKey = this.callbacks.canonicalCityKey(
      String(input.destinationCity || input.route?.next_visiting_location || ''),
    );
    const isIntercityDirectRoute =
      sourceKey !== '' &&
      destinationKey !== '' &&
      sourceKey !== destinationKey &&
      directToNext === 1;

    if (!input.isLastRoute && !isIntercityDirectRoute) {
      const travel = await this.distanceHelper.fromSourceAndDestination(
        input.tx,
        input.sourceCity,
        input.destinationCity,
        2,
        undefined,
        input.destCityCoords,
      );
      const travelPlusBufferSeconds =
        timeToSeconds(travel.travelTime) + timeToSeconds(travel.bufferTime);
      latestNonHotelEndSeconds = input.routeEndSeconds - travelPlusBufferSeconds;
      if (latestNonHotelEndSeconds > 0) {
        const hours = Math.floor(latestNonHotelEndSeconds / 3600);
        const minutes = Math.floor((latestNonHotelEndSeconds % 3600) / 60);
        const seconds = latestNonHotelEndSeconds % 60;
        latestNonHotelEndTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      } else {
        latestNonHotelEndSeconds = 0;
        latestNonHotelEndTime = '00:00:00';
      }
    }
    return { latestNonHotelEndSeconds, latestNonHotelEndTime };
  }
}
