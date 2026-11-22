import { Module } from '@nestjs/common';
import { ItineraryDropdownsController } from './itinerary-dropdowns.controller';
import { ItineraryDropdownsService } from './itinerary-dropdowns.service';
import { PrismaService } from '../../prisma.service';
import { VehicleUpgradePricingService } from './vehicle-upgrade-pricing.service';

@Module({
  controllers: [ItineraryDropdownsController],
  providers: [
    ItineraryDropdownsService,
    VehicleUpgradePricingService,
    PrismaService,
  ],
  exports: [ItineraryDropdownsService],
})
export class ItineraryDropdownsModule {}