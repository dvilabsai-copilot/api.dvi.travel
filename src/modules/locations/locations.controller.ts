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
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import {
  BulkTollPayloadDto,
  CreateLocationDto,
  LocationResponseDto,
  ModifyLocationNameDto,
  TollResponseDto,
  UpdateLocationDto,
} from './dto/location.dto';

@ApiTags('Locations')
@ApiBearerAuth()
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
