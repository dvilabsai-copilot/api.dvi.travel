import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { StaahController } from './staah.controller';
import { StaahService } from './staah.service';

@Module({
  controllers: [StaahController],
  providers: [StaahService, PrismaService],
  exports: [StaahService],
})
export class StaahModule {}
