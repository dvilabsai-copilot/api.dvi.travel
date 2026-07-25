import { Module } from '@nestjs/common';
import { CitiesController } from './cities.controller';
import { CitiesService } from './cities.service';
import { PrismaService } from '../../../prisma.service';

@Module({
  controllers: [CitiesController],
 providers: [CitiesService, PrismaService], // ensures DI works
  exports: [CitiesService],
})
export class CitiesModule {}