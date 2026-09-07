import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../../auth/public.decorator';
import type { ItineraryViewer } from '../itineraries/services/itinerary-access.service';
import { CreatePublicItineraryLinkDto } from './dto/create-public-itinerary-link.dto';
import { PublicItineraryLinksService } from './public-itinerary-links.service';
import { PublicItineraryReadService } from './public-itinerary-read.service';

type AuthenticatedRequest = Request & {
  user?: ItineraryViewer;
};

@Controller('public-itinerary-links')
export class PublicItineraryLinksController {
  constructor(
    private readonly publicItineraryLinksService: PublicItineraryLinksService,
    private readonly publicItineraryReadService: PublicItineraryReadService,
  ) {}

  @Post()
  createPublicLink(
    @Body() dto: CreatePublicItineraryLinkDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.publicItineraryLinksService.createPublicLink(
      dto,
      request.user,
    );
  }

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  getPublicItinerary(
    @Param('token') token: string,
  ) {
    return this.publicItineraryReadService.resolvePublicItinerary(
      token,
    );
  }
}