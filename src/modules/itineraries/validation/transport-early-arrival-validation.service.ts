import { BadRequestException, Injectable } from '@nestjs/common';
import { CreatePlanDto } from '../dto/create-itinerary.dto';
import {
  DEFAULT_TRANSPORT_EARLY_ARRIVAL_CUTOFF,
  getTransportEarlyArrivalSetting,
  wallClockMinutes,
} from '../transport-early-arrival';

@Injectable()
export class TransportEarlyArrivalValidationService {
  validate(plan: CreatePlanDto): void {
    const cutoff = wallClockMinutes(
      getTransportEarlyArrivalSetting(
        'TRANSPORT_EARLY_ARRIVAL_CUTOFF',
        DEFAULT_TRANSPORT_EARLY_ARRIVAL_CUTOFF,
      ),
    ) ?? 8 * 60;
    const arrivalMinutes = wallClockMinutes(plan.trip_start_date);
    const requiresDecision =
      Number(plan.itinerary_preference) === 2 &&
      arrivalMinutes !== null &&
      arrivalMinutes < cutoff;

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
