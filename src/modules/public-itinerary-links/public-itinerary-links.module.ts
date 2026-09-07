import { Module } from '@nestjs/common';

import { ItinerariesModule } from '../itineraries/itinerary.module';
import { PublicItineraryLinksController } from './public-itinerary-links.controller';
import { PublicItineraryLinksService } from './public-itinerary-links.service';
import { PublicItineraryReadService } from './public-itinerary-read.service';

@Module({
  imports: [
    ItinerariesModule,
  ],
  controllers: [
    PublicItineraryLinksController,
  ],
  providers: [
    PublicItineraryLinksService,
    PublicItineraryReadService,
  ],
})
export class PublicItineraryLinksModule {}