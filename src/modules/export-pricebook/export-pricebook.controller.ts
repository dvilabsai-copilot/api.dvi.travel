import {
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ExportPricebookService } from './export-pricebook.service';
import {
  VehiclePricebookQueryDto,
  HotelRoomExportQueryDto,
  HotelAmenityExportQueryDto,
  GuideExportQueryDto,
  HotspotExportQueryDto,
  ActivityQueryDto,
  TollQueryDto,
  ParkingQueryDto,
} from './dto/export-pricebook.dto';

@ApiTags('export-pricebook')
@ApiBearerAuth()
@Controller('export-pricebook')
export class ExportPricebookController {
  constructor(private readonly svc: ExportPricebookService) {}

 // ---------------- VEHICLE ----------------

  @Get('vehicle')
  async listVehicle(@Query() q: VehiclePricebookQueryDto) {
    return this.svc.getVehiclePricebook(q);
  }

  @Get('vehicle/excel')
  async exportVehicleExcel(@Query() q: VehiclePricebookQueryDto, @Res() res: Response) {
    return this.svc.exportVehiclePricebookExcel(q, res);
  }

 // ---------------- HOTEL ROOMS (DATE RANGE) ----------------

  @Get('hotel-room/excel')
  async exportHotelRoomExcel(@Query() q: HotelRoomExportQueryDto, @Res() res: Response) {
    return this.svc.exportHotelRoomPricebookExcel(q, res);
  }

 // ---------------- HOTEL AMENITIES ----------------

  @Get('hotel-amenities/excel')
  async exportHotelAmenitiesExcel(@Query() q: HotelAmenityExportQueryDto, @Res() res: Response) {
    return this.svc.exportHotelAmenitiesPricebookExcel(q, res);
  }

 // ---------------- GUIDE ----------------

  @Get('guide/excel')
  async exportGuideExcel(@Query() q: GuideExportQueryDto, @Res() res: Response) {
    return this.svc.exportGuidePricebookExcel(q, res);
  }

 // ---------------- HOTSPOT ----------------

  @Get('hotspot/excel')
  async exportHotspotExcel(@Query() q: HotspotExportQueryDto, @Res() res: Response) {
    return this.svc.exportHotspotPricebookExcel(q, res);
  }

 // ---------------- ACTIVITY ----------------

  @Get('activity')
  async listActivity(@Query() q: ActivityQueryDto) {
    return this.svc.getActivityPricebook(q);
  }

  @Get('activity/excel')
  async exportActivityExcel(@Query() q: ActivityQueryDto, @Res() res: Response) {
    return this.svc.exportActivityPricebookExcel(q, res);
  }

 // ---------------- TOLL ----------------

  @Get('toll')
  async listToll(@Query() q: TollQueryDto) {
    return this.svc.getTollPricebook(q);
  }

  @Get('toll/excel')
  async exportTollExcel(@Query() q: TollQueryDto, @Res() res: Response) {
    return this.svc.exportTollPricebookExcel(q, res);
  }

 // ---------------- PARKING ----------------

  @Get('parking')
  async listParking(@Query() q: ParkingQueryDto) {
    return this.svc.getParkingPricebook(q);
  }

  @Get('parking/excel')
  async exportParkingExcel(@Query() q: ParkingQueryDto, @Res() res: Response) {
    return this.svc.exportParkingPricebookExcel(q, res);
  }
}
