// add imports
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ItineraryViaRoutesService } from './itinerary-via-routes.service';
import { CheckDistanceLimitDto } from './dto/check-distance-limit.dto';
import { AddViaRouteDto } from './dto/add-via-route.dto';
import { ShowViaRouteFormDto } from './dto/show-form.dto';

@ApiTags('itinerary-via-routes')
@ApiBearerAuth()
@Controller('itinerary-via-routes')
export class ItineraryViaRoutesController {
  constructor(
    private readonly itineraryViaRoutesService: ItineraryViaRoutesService,
  ) {}

  @Get('form')
  async getForm(@Query() query: ShowViaRouteFormDto) {
    // PHP: ajax_latest_itineary_via_route_form.php?type=show_form&...
    return this.itineraryViaRoutesService.getForm(query);
  }

  @Post('check-distance-limit')
  @HttpCode(HttpStatus.OK)
  async checkDistanceLimit(@Body() dto: CheckDistanceLimitDto) {
    return this.itineraryViaRoutesService.checkDistanceLimit(dto);
  }

  @Post('add')
  async addViaRoute(@Body() dto: AddViaRouteDto) {
    return this.itineraryViaRoutesService.addViaRoute(dto);
  }
}
