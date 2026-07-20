import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CreateRouteVehicleRestrictionDto, EvaluateRouteVehicleRestrictionDto, UpdateRouteVehicleRestrictionDto } from './dto/route-vehicle-restriction.dto';
import { RouteVehicleRestrictionService } from './route-vehicle-restriction.service';

@Controller('route-vehicle-restrictions')
export class RouteVehicleRestrictionsController {
  constructor(private readonly service: RouteVehicleRestrictionService) {}

  private userId(req: any): number { return Number(req?.user?.userId || req?.user?.id || 1); }

  @Get() list() { return this.service.list(); }
  @Get('route-options') routeOptions(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.routeOptions(search, Number(page || 1), Number(limit || 50));
  }
  @Get('vehicle-options') vehicleOptions() { return this.service.vehicleOptions(); }
  @Post('evaluate') evaluate(@Body() dto: EvaluateRouteVehicleRestrictionDto) { return this.service.evaluate(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(Number(id)); }
  @Post() create(@Body() dto: CreateRouteVehicleRestrictionDto, @Req() req: any) { return this.service.create(dto, this.userId(req)); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateRouteVehicleRestrictionDto, @Req() req: any) { return this.service.update(Number(id), dto, this.userId(req)); }
  @Delete(':id') remove(@Param('id') id: string, @Req() req: any) { return this.service.remove(Number(id), this.userId(req)); }
}
