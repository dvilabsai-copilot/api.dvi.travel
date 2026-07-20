import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma.module';
import { RouteVehicleRestrictionsController } from './route-vehicle-restrictions.controller';
import { RouteVehicleRestrictionService } from './route-vehicle-restriction.service';

@Module({
  imports: [PrismaModule],
  controllers: [RouteVehicleRestrictionsController],
  providers: [RouteVehicleRestrictionService],
  exports: [RouteVehicleRestrictionService],
})
export class RouteVehicleRestrictionsModule {}
