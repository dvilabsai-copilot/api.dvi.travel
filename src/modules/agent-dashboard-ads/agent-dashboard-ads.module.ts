import { Module } from '@nestjs/common';
import { AgentDashboardAdsController, AgentDashboardAdsAdminGuard } from './agent-dashboard-ads.controller';
import { AgentDashboardAdsService } from './agent-dashboard-ads.service';

/** Isolated ad feature: no Prisma, database migration, or changes to other modules. */
@Module({
  controllers: [AgentDashboardAdsController],
  providers: [AgentDashboardAdsService, AgentDashboardAdsAdminGuard],
})
export class AgentDashboardAdsModule {}
