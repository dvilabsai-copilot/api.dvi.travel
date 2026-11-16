import { BadRequestException, Injectable } from '@nestjs/common';
import { CreatePlanDto, CreateRouteDto } from '../dto/create-itinerary.dto';
import {
  isTransportIntercityTransfer,
  transportEarlyArrivalCutoffMinutes,
  wallClockMinutes,
} from '../transport-early-arrival';

@Injectable()
export class TransportEarlyArrivalValidationService {
  validate(plan: CreatePlanDto, routes: CreateRouteDto[] = []): void {
    const firstRoute = routes.find((route) => Number(route.no_of_days) === 1) ?? routes[0];
    const arrivalMinutes = wallClockMinutes(plan.trip_start_date);
    const requiresDecision =
      Number(plan.itinerary_preference) === 2 &&
      arrivalMinutes !== null &&
      arrivalMinutes < transportEarlyArrivalCutoffMinutes() &&
      !isTransportIntercityTransfer(firstRoute?.location_name, firstRoute?.next_visiting_location);

    if (!requiresDecision) return;

    if (!plan.transport_early_arrival_option) {
      throw new BadRequestException({
        code: 'TRANSPORT_EARLY_ARRIVAL_PREFERENCE_REQUIRED',
        message:
          'Select hotel rest or refreshment break for the early-morning Transport Only arrival.',
      });
    }

  }
}
