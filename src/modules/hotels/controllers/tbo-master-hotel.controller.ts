import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TboMasterPricePreviewDto, UpdateTboMasterHotelDto } from '../dto/tbo-master.dto';
import { TboMasterHotelService } from '../services/tbo-master-hotel.service';

@ApiTags('tbo-master-hotels')
@ApiBearerAuth()
@Controller('hotels/tbo-master')
export class TboMasterHotelController {
  constructor(private readonly service: TboMasterHotelService) {}

  @Get()
  list(@Query() query: { search?: string; cityCode?: string; page?: string; limit?: string; priority?: string }) {
    return this.service.list({ ...query, page: Number(query.page || 1), limit: Number(query.limit || 20) });
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.service.get(code);
  }

  @Patch(':code/priority')
  priority(@Param('code') code: string, @Body('isPriority') isPriority: boolean) {
    return this.service.setPriority(code, Boolean(isPriority));
  }

  @Patch(':code')
  update(@Param('code') code: string, @Body() dto: UpdateTboMasterHotelDto, @Req() req: any) {
    return this.service.update(code, dto, Number(req?.user?.id) || undefined);
  }

  @Post(':code/price-preview')
  pricePreview(@Param('code') code: string, @Body() dto: TboMasterPricePreviewDto) {
    return this.service.pricePreview(code, dto);
  }
}
