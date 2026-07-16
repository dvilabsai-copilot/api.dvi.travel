import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { PrismaService } from '../../prisma.service';
import { LocationGeoPolicyService } from './services/location-geo-policy.service';

@Module({
  controllers: [LocationsController],
  providers: [PrismaService, LocationGeoPolicyService, LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
