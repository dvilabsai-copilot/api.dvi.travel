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
    // Role 4 is Agent
    if (user.role === 4) {
      return this.dashboardService.getAgentDashboardStats(Number(user.agentId));
    }
    // Role 6 is Accounts
    if (user.role === 6) {
      return this.dashboardService.getAccountsDashboardStats();
    }
    // Role 2 is Vendor
    if (user.role === 2 || (user.vendorId && user.vendorId > 0)) {
      return this.dashboardService.getVendorDashboardStats(Number(user.vendorId));
    }
    // Role 3 or 8 is Travel Expert / Staff
    if (user.role === 3 || user.role === 8 || (user.staffId && user.staffId > 0)) {
      return this.dashboardService.getTravelExpertDashboardStats(Number(user.staffId));
    }
    // Role 5 is Guide
    if (user.role === 5 || (user.guideId && user.guideId > 0)) {
      return this.dashboardService.getGuideDashboardStats(Number(user.guideId));
    }
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
