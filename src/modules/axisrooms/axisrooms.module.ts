import { Module } from '@nestjs/common';
import { AxisRoomsController } from './axisrooms.controller';
import { AxisRoomsAdminController } from './axisrooms-admin.controller';
import { AxisRoomsService } from './axisrooms.service';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [AxisRoomsController, AxisRoomsAdminController],
  providers: [AxisRoomsService, PrismaService],
  exports: [AxisRoomsService],
})
export class AxisRoomsModule {}
