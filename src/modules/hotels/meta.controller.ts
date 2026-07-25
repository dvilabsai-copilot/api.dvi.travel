// REPLACE WHOLE FILE
// src/modules/hotels/meta.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { HotelsService } from './hotels.service';

@Controller('meta')
export class MetaController {
  constructor(private readonly hotels: HotelsService) {}

 // ------------------------------------------------------------------
 // Countries
 // ------------------------------------------------------------------
  @Get('countries')
  countries() {
    return this.hotels.countries();
  }

 // ------------------------------------------------------------------
 // States
 // - /api/v1/meta/states?countryId=1 states of a country
 // - /api/v1/meta/states?all=1 all states (no country filter)
 // - /api/v1/meta/states/:id single state by id
 // ------------------------------------------------------------------
  @Get('states')
  states(
    @Query('countryId') countryId?: string,
    @Query('all') all?: string,
  ) {
 // If UI asks for "all=1", return all states
    if (String(all) === '1') {
      return this.hotels.statesAll();
    }
 // Else, return states for the given country (or empty if missing)
    return this.hotels.states(Number(countryId));
  }

  @Get('states/:id')
  stateById(@Param('id') id: string) {
    return this.hotels.stateById(Number(id));
  }

 // ------------------------------------------------------------------
 // Cities
 // - /api/v1/meta/cities?stateId=10 cities of a state
 // - /api/v1/meta/cities?all=1 all cities (no state filter)
 // - /api/v1/meta/cities/:id single city by id
 // ------------------------------------------------------------------
  @Get('cities')
  cities(
    @Query('stateId') stateId?: string,
    @Query('all') all?: string,
  ) {
    if (String(all) === '1') {
      return this.hotels.citiesAll();
    }
    return this.hotels.cities(Number(stateId));
  }

  @Get('cities/:id')
  cityById(@Param('id') id: string) {
    return this.hotels.cityById(Number(id));
  }

 // ------------------------------------------------------------------
 // GST meta
 // ------------------------------------------------------------------
  @Get('gst/types')
  gstTypes() {
    return this.hotels.gstTypes();
  }

  @Get('gst/percentages')
  gstPercentages() {
    return this.hotels.gstPercentages();
  }

 // ------------------------------------------------------------------
 // Inbuilt amenities master (rooms tab)
 // ------------------------------------------------------------------
  @Get('inbuilt-amenities')
  inbuiltAmenities() {
    return this.hotels.inbuiltAmenities();
  }

 // Optional alias: /api/v1/meta/amenities
  @Get('amenities')
  amenities() {
    return this.hotels.inbuiltAmenities();
  }

 // ------------------------------------------------------------------
 // Rooms: Preferred For options
 // ------------------------------------------------------------------
  @Get('rooms/pref-for')
  roomPrefFor() {
 // Match the fallback array used in HotelForm.tsx RoomsStep
    return ['Family', 'Friends', 'Adults', 'Couples'];
  }
}
