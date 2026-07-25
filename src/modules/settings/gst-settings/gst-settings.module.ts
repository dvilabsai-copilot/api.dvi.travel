import { Module } from '@nestjs/common';
import { GstSettingsController } from './gst-settings.controller';
import { GstSettingsService } from './gst-settings.service';
import { PrismaService } from '../../../prisma.service';

@Module({
  controllers: [GstSettingsController],
 providers: [GstSettingsService, PrismaService], // ensures DI works
  exports: [GstSettingsService],
})
export class GstSettingsModule {}
