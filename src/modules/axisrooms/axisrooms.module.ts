import { Module } from '@nestjs/common';
import { AxisRoomsController } from './axisrooms.controller';
import { AxisRoomsService } from './axisrooms.service';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [AxisRoomsController],
  providers: [AxisRoomsService, PrismaService],
  exports: [AxisRoomsService],
})
export class AxisRoomsModule {}
