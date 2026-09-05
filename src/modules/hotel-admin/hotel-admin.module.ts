import { Module } from '@nestjs/common';
import { HotelsModule } from '../hotels/hotels.module';
import { HotelAdminController } from './hotel-admin.controller';
import { HotelAdminService } from './hotel-admin.service';
import { HotelAdminReadService } from './hotel-admin-read.service';
import { HotelAdminGuard } from './guards/hotel-admin.guard';

@Module({
  imports: [
    HotelsModule,
  ],
  controllers: [
    HotelAdminController,
  ],
  providers: [
    HotelAdminService,
    HotelAdminReadService,
    HotelAdminGuard,
  ],
  exports: [
    HotelAdminService,
  ],
})
export class HotelAdminModule {}