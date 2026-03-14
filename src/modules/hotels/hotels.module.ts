
// src/modules/hotels/hotels.module.ts
import { Module } from '@nestjs/common';
import {
  HotelsController,
  LocationsController,
  RootStatesController,
  RootCitiesController,
  DviGeoController,
  PreviewAliasesController
} from './hotels.controller';
import { MetaController } from './meta.controller';
import { HotelSearchController } from './controllers/hotel-search.controller';
import { HotelConfirmController } from './controllers/hotel-confirm.controller';
import { HotelMasterSyncController } from './controllers/hotel-master-sync.controller';
import { HotelsService } from './hotels.service';
import { TBOHotelProvider } from './providers/tbo-hotel.provider';
import { ResAvenueHotelProvider } from './providers/resavenue-hotel.provider';
import { HobseHotelProvider } from './providers/hobse-hotel.provider';
import { HotelSearchService } from './services/hotel-search.service';
import { HotelConfirmService } from './services/hotel-confirm.service';
import { TboHotelMasterSyncService } from './services/tbo-hotel-master-sync.service';
import { TboSoapSyncService } from './services/tbo-soap-sync.service';
import { TboApiSyncService } from './services/tbo-api-sync.service';
import { HobseHotelMasterSyncService } from './services/hobse-hotel-master-sync.service';
import { HobseHotelCsvImportService } from './services/hobse-hotel-csv-import.service';

@Module({
  imports: [],
  controllers: [
    HotelsController,
    LocationsController,
    RootStatesController,
    RootCitiesController,
    DviGeoController,
    MetaController,
    PreviewAliasesController,
    HotelSearchController,
    HotelConfirmController,
    HotelMasterSyncController,
  ],
  providers: [
    HotelsService,
    TBOHotelProvider,
    ResAvenueHotelProvider,
    HobseHotelProvider,
    HotelSearchService,
    HotelConfirmService,
    TboHotelMasterSyncService,
    TboSoapSyncService,
    TboApiSyncService,
    HobseHotelMasterSyncService, // ✅ NEW
    HobseHotelCsvImportService,
  ],
  exports: [
    HotelsService,
    HotelSearchService,
    HotelConfirmService,
    TBOHotelProvider,
    ResAvenueHotelProvider,
    HobseHotelProvider,
    TboSoapSyncService,
    TboApiSyncService,
    HobseHotelMasterSyncService, // optional export
    HobseHotelCsvImportService,
  ],
})
export class HotelsModule {}
