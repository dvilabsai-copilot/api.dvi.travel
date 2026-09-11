import { Module } from '@nestjs/common';
import { HotelsModule } from '../hotels/hotels.module';
import { HotelAdminController } from './hotel-admin.controller';
import { HotelAdminService } from './hotel-admin.service';
import { HotelAdminReadService } from './hotel-admin-read.service';
import { HotelAdminGuard } from './guards/hotel-admin.guard';
import { HotelAdminBootstrapController } from './hotel-admin-bootstrap.controller';
import { HotelAdminBootstrapService } from './hotel-admin-bootstrap.service';

@Module({
  imports: [
    HotelsModule,
  ],
  controllers: [
    HotelAdminController,
    HotelAdminBootstrapController,
  ],
  providers: [
    HotelAdminService,
    HotelAdminReadService,
    HotelAdminGuard,
    HotelAdminBootstrapService,
  ],
  exports: [
    HotelAdminService,
  ],
})
export class HotelAdminModule {}
