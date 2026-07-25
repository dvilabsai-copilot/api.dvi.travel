import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import {
  BetweenHotspotFiltersQueryDto,
  BetweenHotspotQueryDto,
  BulkTollPayloadDto,
  CreateLocationDto,
  CreateSuggestedRouteDto,
  LocationPreviewCreateViaRouteDto,
  LocationResponseDto,
  ModifyLocationNameDto,
  RenameLocationNameDto,
  SuggestedRouteResponseDto,
  TollResponseDto,
  UpdateLocationDto,
  UpdateSuggestedRouteDto,
  UpdateViaRouteDto,
  ViaRouteResponseDto,
} from './dto/location.dto';

@ApiTags('Locations')
@ApiBearerAuth()
@ApiExtraModels(ViaRouteResponseDto, SuggestedRouteResponseDto)
@Controller('locations')
export class LocationsController {
  constructor(private readonly svc: LocationsService) {}

  @Get()
  @ApiOperation({ summary: 'List locations with filters & pagination' })
  @ApiQuery({ name: 'source', required: false })
  @ApiQuery({ name: 'destination', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { $ref: '#/components/schemas/LocationResponseDto' } },
        total: { type: 'number' },
        page: { type: 'number' },
        pageSize: { type: 'number' },
      },
    },
  })
  list(@Query() q: any) {
    return this.svc.list(q);
  }

  @Get('dropdowns')
  @ApiOperation({ summary: 'Fetch dropdown options for Source/Destination' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        sources: { type: 'array', items: { type: 'string' } },
        destinations: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  dropdowns() {
    return this.svc.dropdowns();
  }

  @Get('between-hotspots/filters')
  @ApiOperation({ summary: 'Read-only valid filter options for between-hotspots screen' })
  @ApiQuery({ name: 'locationId', required: false, type: Number })
  @ApiQuery({ name: 'sourceHotspotId', required: false, type: Number })
  @ApiQuery({ name: 'onlyUsable', required: false, type: String, description: 'true/1 for ON_ROUTE + MINOR_DETOUR only' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        locations: { type: 'array' },
        sourceHotspots: { type: 'array' },
        destinationHotspots: { type: 'array' },
      },
    },
  })
  getBetweenHotspotFilters(@Query() q: BetweenHotspotFiltersQueryDto) {
    return this.svc.getBetweenHotspotFilterOptions(q);
  }

  @Get('between-hotspots')
  @ApiOperation({ summary: 'Read-only between hotspots by source/destination hotspot IDs and optional location context' })
  @ApiQuery({ name: 'sourceHotspotId', required: true, type: Number })
  @ApiQuery({ name: 'destinationHotspotId', required: true, type: Number })
  @ApiQuery({ name: 'locationId', required: false, type: Number })
  @ApiQuery({ name: 'onlyUsable', required: false, type: String, description: 'true/1 for ON_ROUTE + MINOR_DETOUR only' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        rows: { type: 'array' },
        total: { type: 'number' },
        page: { type: 'number' },
        pageSize: { type: 'number' },
        locationContext: { type: 'object', nullable: true },
      },
    },
  })
  getBetweenHotspots(@Query() q: BetweenHotspotQueryDto) {
    return this.svc.getBetweenHotspots(q);
  }

  @Get('autosuggest/cities')
  @ApiOperation({ summary: 'Autosuggest cities (legacy PHP-compatible shape)' })
  @ApiQuery({ name: 'phrase', required: false, type: String })
  @ApiQuery({ name: 'format', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          get_city: { type: 'string' },
        },
      },
    },
  })
  cityAutosuggest(
    @Query('phrase') phrase?: string,
    @Query('format') format?: string,
    @Query('type') type?: string,
  ) {
    return this.svc.searchCities({ phrase, format, type });
  }

  @Get('autosuggest/states')
  @ApiOperation({ summary: 'Autosuggest states (legacy PHP-compatible shape)' })
  @ApiQuery({ name: 'phrase', required: false, type: String })
  @ApiQuery({ name: 'format', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          get_state: { type: 'string' },
        },
      },
    },
  })
  stateAutosuggest(
    @Query('phrase') phrase?: string,
    @Query('format') format?: string,
    @Query('type') type?: string,
  ) {
    return this.svc.searchStates({ phrase, format, type });
  }

  @Post()
@ApiOperation({ summary: 'Add Location' })
@ApiResponse({ status: 201, type: LocationResponseDto })
@ApiResponse({ status: 400, description: 'Validation error' })
create(@Body() dto: CreateLocationDto) {
  return this.svc.create(dto);
}

   @Patch('location-name')
  @ApiOperation({ summary: 'Rename a location name everywhere it appears' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        oldName: { type: 'string' },
        newName: { type: 'string' },
        updatedCount: { type: 'number' },
      },
    },
  })
  updateLocationName(@Body() dto: RenameLocationNameDto) {
    return this.svc.updateLocationName(dto.old_name, dto.new_name, dto.scope || 'both');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single Location by ID' })
  @ApiResponse({ status: 200, type: LocationResponseDto })
  @ApiResponse({ status: 404, description: 'Location not found' })
  get(@Param('id') id: string) {
    return this.svc.get(Number(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update Location (all fields optional)' })
  @ApiResponse({ status: 200, type: LocationResponseDto })
  @ApiResponse({ status: 404, description: 'Location not found' })
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.svc.update(Number(id), dto);
  }

  @Patch(':id/modify-name')
  @ApiOperation({
    summary: 'Quick rename Source/Destination location string',
  })
  @ApiResponse({ status: 200, type: LocationResponseDto })
  @ApiResponse({ status: 404, description: 'Location not found' })
  modifyName(@Param('id') id: string, @Body() dto: ModifyLocationNameDto) {
    return this.svc.modifyName(Number(id), dto.scope, dto.new_name);
  }

  @Delete('location-name')
@HttpCode(200)
deleteLocationName(@Query('location') location: string) {
  return this.svc.deleteLocationName(location);
}
    @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete location by ID' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        row: { $ref: '#/components/schemas/LocationResponseDto' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  softDelete(@Param('id') id: string) {
    return this.svc.softDelete(Number(id));
  }

  @Patch(':id/restore')
  @ApiOperation({ summary: 'Restore soft-deleted location by ID' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        row: { $ref: '#/components/schemas/LocationResponseDto' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  restore(@Param('id') id: string) {
    return this.svc.restore(Number(id));
  }
      @Get(':id/via-routes/place-details')
  @ApiOperation({ summary: 'Lookup a stored place and autofill via-route details' })
  @ApiQuery({ name: 'place', required: true, type: String })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        data: {
          type: 'object',
          nullable: true,
          properties: {
            via_route_location: { type: 'string' },
            via_route_location_city: { type: 'string' },
            via_route_location_state: { type: 'string' },
            via_route_location_lattitude: { type: 'string' },
            via_route_location_longitude: { type: 'string' },
            distance_from_source_location: { type: 'string' },
            duration_from_source_location: { type: 'string' },
          },
        },
      },
    },
  })
  lookupViaRoutePlace(
    @Param('id') id: string,
    @Query('place') place: string,
  ) {
    return this.svc.lookupViaRoutePlace(Number(id), place);
  }

  @Get(':id/via-routes')
  @ApiOperation({ summary: 'Get via-routes for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/ViaRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  getViaRoutes(@Param('id') id: string) {
    return this.svc.getViaRoutes(Number(id));
  }



  @Post(':id/via-routes')
  @ApiOperation({ summary: 'Add a via-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/ViaRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  addViaRoute(@Param('id') id: string, @Body() dto: LocationPreviewCreateViaRouteDto) {
    return this.svc.addViaRoute(Number(id), dto);
  }

  @Patch(':id/via-routes/:viaRouteId')
  @ApiOperation({ summary: 'Update a via-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/ViaRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location or via-route not found' })
  updateViaRoute(
    @Param('id') id: string,
    @Param('viaRouteId') viaRouteId: string,
    @Body() dto: UpdateViaRouteDto,
  ) {
    return this.svc.updateViaRoute(Number(id), Number(viaRouteId), dto);
  }

  @Delete(':id/via-routes/:viaRouteId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a via-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/ViaRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location or via-route not found' })
  deleteViaRoute(
    @Param('id') id: string,
    @Param('viaRouteId') viaRouteId: string,
  ) {
    return this.svc.deleteViaRoute(Number(id), Number(viaRouteId));
  }

  @Get(':id/suggested-routes')
  @ApiOperation({ summary: 'Get suggested-routes for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/SuggestedRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  getSuggestedRoutes(@Param('id') id: string) {
    return this.svc.getSuggestedRoutes(Number(id));
  }

    @Post(':id/suggested-routes')
  @ApiOperation({ summary: 'Add a suggested-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/SuggestedRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  addSuggestedRoute(
    @Param('id') id: string,
    @Body() dto: CreateSuggestedRouteDto,
  ) {
    return this.svc.addSuggestedRoute(Number(id), dto);
  }

  @Patch(':id/suggested-routes/:suggestedRouteId')
  @ApiOperation({ summary: 'Update a suggested-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/SuggestedRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location or suggested-route not found' })
  updateSuggestedRoute(
    @Param('id') id: string,
    @Param('suggestedRouteId') suggestedRouteId: string,
    @Body() dto: UpdateSuggestedRouteDto,
  ) {
    return this.svc.updateSuggestedRoute(Number(id), Number(suggestedRouteId), dto);
  }

  @Delete(':id/suggested-routes/:suggestedRouteId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a suggested-route for a location preview' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: { type: 'array', items: { $ref: '#/components/schemas/SuggestedRouteResponseDto' } },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Location or suggested-route not found' })
  deleteSuggestedRoute(
    @Param('id') id: string,
    @Param('suggestedRouteId') suggestedRouteId: string,
  ) {
    return this.svc.deleteSuggestedRoute(Number(id), Number(suggestedRouteId));
  }

  @Get(':id/tolls')
  @ApiOperation({ summary: 'Get toll charges for this location' })
  @ApiResponse({
    status: 200,
    type: [TollResponseDto],
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  getTolls(@Param('id') id: string) {
    return this.svc.getTolls(Number(id));
  }

  @Post(':id/tolls')
  @ApiOperation({ summary: 'Save/update toll charges for location' })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    },
  })
  @ApiResponse({ status: 404, description: 'Location not found' })
  upsertTolls(
    @Param('id') id: string,
    @Body() body: BulkTollPayloadDto,
    @Req() req: any,
  ) {
    const userId = Number(req?.user?.id) || 0;
    return this.svc.upsertTolls(Number(id), body.items || [], userId);
  }
}
