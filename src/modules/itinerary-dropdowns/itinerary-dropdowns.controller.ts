// FILE: src/modules/itinerary-dropdowns/itinerary-dropdowns.controller.ts

import { Controller, Get, Query, Post, Body } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiQuery,
  ApiTags,
  ApiOperation,
} from '@nestjs/swagger';
import { ItineraryDropdownsService } from './itinerary-dropdowns.service';
import {
  EligibleVehicleTypesDto,
  EligibleVehicleTypesResponseDto,
} from './dto/eligible-vehicle-types.dto';

@ApiTags('Itinerary Dropdowns')
@ApiBearerAuth()
@Controller('itinerary-dropdowns')
export class ItineraryDropdownsController {
  constructor(private readonly svc: ItineraryDropdownsService) {}

  /**
   * GET /itinerary-dropdowns/locations
   *
   * - Source locations (default):  ?type=source
   * - Destination locations:       ?type=destination&source=Chennai
   */
  @Get('locations')
  @ApiOperation({
    summary: 'List source / destination locations',
    description:
      'If type=source (default), returns distinct source locations. ' +
      'If type=destination, returns distinct destinations for the given source.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['source', 'destination'],
    example: 'source',
  })
  @ApiQuery({
    name: 'source',
    required: false,
    description: 'Source location (required when type=destination)',
    example: 'Chennai',
  })
  locations(
    @Query('type') type: 'source' | 'destination' = 'source',
    @Query('source') source?: string,
  ) {
    return this.svc.getLocations(type, source);
  }

  @Get('itinerary-types')
  @ApiOperation({ summary: 'List itinerary types' })
  itineraryTypes() {
    return this.svc.getItineraryTypes();
  }

  @Get('travel-types')
  @ApiOperation({ summary: 'List travel types' })
  travelTypes() {
    return this.svc.getTravelTypes();
  }

  @Get('entry-ticket-options')
  @ApiOperation({ summary: 'List entry ticket options' })
  entryTicketOptions() {
    return this.svc.getEntryTicketOptions();
  }

  @Get('guide-options')
  @ApiOperation({ summary: 'List guide options' })
  guideOptions() {
    return this.svc.getGuideOptions();
  }

  @Get('nationalities')
  @ApiOperation({ summary: 'List nationalities' })
  nationalities() {
    return this.svc.getNationalities();
  }

  @Get('food-preferences')
  @ApiOperation({ summary: 'List food preferences' })
  foodPreferences() {
    return this.svc.getFoodPreferences();
  }

  @Get('vehicle-types')
  @ApiOperation({ summary: 'List vehicle types' })
  vehicleTypes() {
    return this.svc.getVehicleTypes();
  }

  @Post('eligible-vehicle-types')
  @ApiOperation({
    summary: 'Get eligible vehicle types by location',
    description:
      'Mirrors legacy PHP: accepts source and destination locations, ' +
      'filters vehicles by cities in those locations, ' +
      'and sorts by seating capacity (ascending). ' +
      'Optionally returns selected vehicle IDs for an itinerary plan.',
  })
  async getEligibleVehicleTypes(
    @Body() dto: EligibleVehicleTypesDto,
  ): Promise<EligibleVehicleTypesResponseDto> {
    return this.svc.getEligibleVehicleTypes(dto);
  }

  @Get('hotel-categories')
  @ApiOperation({ summary: 'List hotel categories' })
  hotelCategories() {
    return this.svc.getHotelCategories();
  }

  @Get('hotel-facilities')
  @ApiOperation({ summary: 'List hotel facilities' })
  hotelFacilities() {
    return this.svc.getHotelFacilities();
  }

  // ---------------------------------------------------------------------------
  // VIA ROUTES  (single clean style: source + destination)
  // ---------------------------------------------------------------------------
  @Get('via-routes')
  @ApiOperation({
    summary: 'List via routes between source and destination',
    description:
      'Uses dvi_stored_locations + dvi_itinerary_route_hotspot_details ' +
      'same as the old PHP logic.',
  })
  @ApiQuery({
    name: 'source',
    required: true,
    description: 'Source location name (e.g. Chennai)',
  })
  @ApiQuery({
    name: 'destination',
    required: true,
    description: 'Next visiting place (e.g. Pondicherry)',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search text to filter via route names (optional)',
  })
  async getViaRoutes(
    @Query('source') source: string,
    @Query('destination') destination: string,
    @Query('q') q?: string,
  ) {
    return this.svc.getViaRoutes(source, destination, q);
  }
}
