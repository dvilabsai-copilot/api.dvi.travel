import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TboMasterPricePreviewDto, UpdateTboMasterHotelDto } from '../dto/tbo-master.dto';
import { TboMasterHotelService } from '../services/tbo-master-hotel.service';
import { TboMasterGalleryService } from '../services/tbo-master-gallery.service';

@ApiTags('tbo-master-hotels')
@ApiBearerAuth()
@Controller('hotels/tbo-master')
export class TboMasterHotelController {
  constructor(
    private readonly service: TboMasterHotelService,
    private readonly gallery: TboMasterGalleryService,
  ) {}

  @Get()
  list(@Query() query: { search?: string; cityCode?: string; page?: string; limit?: string; priority?: string }) {
    return this.service.list({ ...query, page: Number(query.page || 1), limit: Number(query.limit || 20) });
  }

  @Get(':code/gallery')
  getGallery(@Param('code') code: string) {
    return this.gallery.getHotelImages(code);
  }

  @Post(':code/gallery')
  @UseInterceptors(FilesInterceptor('images', 12, {
    storage: memoryStorage(),
    limits: { files: 12, fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        return callback(new BadRequestException('Only JPEG, PNG, and WebP images are allowed') as any, false);
      }
      callback(null, true);
    },
  }))
  uploadGallery(@Param('code') code: string, @UploadedFiles() files: Express.Multer.File[], @Req() req: any) {
    return this.gallery.upload(code, files || [], Number(req?.user?.id) || 0);
  }

  @Patch(':code/gallery/:imageId/primary')
  setGalleryPrimary(@Param('code') code: string, @Param('imageId') imageId: string) {
    return this.gallery.setPrimary(code, Number(imageId));
  }

  @Delete(':code/gallery/:imageId')
  deleteGallery(@Param('code') code: string, @Param('imageId') imageId: string) {
    return this.gallery.remove(code, Number(imageId));
  }

  @Get(':code/room-gallery')
  getRoomGallery(@Param('code') code: string) {
    return this.gallery.getRoomImages(code);
  }

  @Post(':code/room-gallery')
  @UseInterceptors(FilesInterceptor('images', 12, {
    storage: memoryStorage(),
    limits: { files: 12, fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
        return callback(new BadRequestException('Only JPEG, PNG, and WebP images are allowed') as any, false);
      }
      callback(null, true);
    },
  }))
  uploadRoomGallery(
    @Param('code') code: string,
    @Body('roomRefCode') roomRefCode: string,
    @Body('roomTitle') roomTitle: string,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: any,
  ) {
    return this.gallery.uploadRoomImages(code, roomRefCode, roomTitle, files || [], Number(req?.user?.id) || 0);
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
