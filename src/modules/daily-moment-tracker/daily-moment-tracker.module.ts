import { Module } from '@nestjs/common';

import { DailyMomentTrackerService } from './daily-moment-tracker.service';

import { DailyMomentTrackerController } from './daily-moment-tracker.controller';

import { PrismaService } from '../../prisma.service';

import { ItineraryBookingConfirmationEmailNotifierService } from '../itineraries/services/itinerary-booking-confirmation-email-notifier.service';

@Module({
  controllers: [DailyMomentTrackerController],

  providers: [
    DailyMomentTrackerService,
    PrismaService,
    ItineraryBookingConfirmationEmailNotifierService,
  ],

  exports: [DailyMomentTrackerService],
})
export class DailyMomentTrackerModule {}