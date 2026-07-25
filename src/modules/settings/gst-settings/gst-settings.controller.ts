import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GstSettingsService } from './gst-settings.service';
import { CreateGstSettingDto } from './dto/create-gst-setting.dto';
import { UpdateGstSettingDto } from './dto/update-gst-setting.dto';

@ApiTags('gst-settings')
@ApiBearerAuth()
@Controller('gst-settings')
export class GstSettingsController {
  constructor(private readonly service: GstSettingsService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.getOne(id);
  }

  @Post()
  create(@Body() dto: CreateGstSettingDto, @Req() req: any) {
    const loggedUserId = Number(req?.user?.id ?? req?.user?.userId ?? 0);
    return this.service.create(dto, loggedUserId);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGstSettingDto,
    @Req() req: any,
  ) {
    const loggedUserId = Number(req?.user?.id ?? req?.user?.userId ?? 0);
    return this.service.update(id, dto, loggedUserId);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.service.remove(id);
    return { ok: true };
  }

 // Optional: your UI can use this for status toggle without editing fields
  @Post(':id/toggle-status')
  toggle(@Param('id', ParseIntPipe) id: number) {
    return this.service.toggleStatus(id);
  }
}
