import { Controller, Get, UseGuards, Req, Query } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

@ApiTags('Dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @UseGuards(JwtAuthGuard)
@Get('stats')
@ApiOperation({ summary: 'Get dashboard statistics' })
async getDashboardStats(@Req() req: any) {
  const user = req.user;

    const role = Number(
    user?.roleID ?? user?.role ?? 0,
  );

  const agentId = Number(
    user?.agentId ?? user?.agent_id ?? 0,
  );

  const vendorId = Number(
    user?.vendorId ?? user?.vendor_id ?? 0,
  );

  const staffId = Number(
    user?.staffId ?? user?.staff_id ?? 0,
  );

  const guideId = Number(
    user?.guideId ?? user?.guide_id ?? 0,
  );
  // Role 4 is Agent
  if (role === 4) {
    return this.dashboardService.getAgentDashboardStats(agentId);
  }

  // Role 6 is Accounts
  if (role === 6) {
    return this.dashboardService.getAccountsDashboardStats();
  }

  // Role 2 is Vendor
  if (role === 2 || vendorId > 0) {
    return this.dashboardService.getVendorDashboardStats(vendorId);
  }

  // Role 5 is Guide
  if (role === 5 || guideId > 0) {
    return this.dashboardService.getGuideDashboardStats(guideId);
  }

  // Role 3 is Staff.
  // Staff must receive the same complete dashboard response as Admin.
  if (role === 3) {
    return this.dashboardService.getDashboardStats();
  }

  // Role 8 retains the limited Travel Expert dashboard.
  if (role === 8) {
    return this.dashboardService.getTravelExpertDashboardStats(staffId);
  }

  // Admin and other permitted internal users use the full dashboard.
  return this.dashboardService.getDashboardStats();
}
  @UseGuards(JwtAuthGuard)
  @Get('most-visited-hotels')
  @ApiOperation({ summary: 'Get most visited hotels for dashboard' })
  async getMostVisitedHotels(
    @Query('year') year?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboardService.getMostVisitedHotels({
      year: Number(year) || new Date().getFullYear(),
      limit: Number(limit) || 5,
    });
  }
}
