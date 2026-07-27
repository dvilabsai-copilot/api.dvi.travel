import { Controller, Get, UseGuards, Req, Query, ForbiddenException } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { SystemRole } from '../auth/constants/system-role.constants';

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
  if (role === SystemRole.VEHICLE_AGENT) {
    if (agentId <= 0) throw new ForbiddenException('Vehicle agent account is not linked to an active agent.');
    return this.dashboardService.getVehicleAgentDashboardStats(agentId);
  }

  if (role === SystemRole.AGENT) {
    return this.dashboardService.getAgentDashboardStats(agentId);
  }

 // Role 6 is Accounts
  if (role === SystemRole.ACCOUNTS) {
    return this.dashboardService.getAccountsDashboardStats();
  }

 // Role 2 is Vendor
  if (role === SystemRole.VENDOR || vendorId > 0) {
    return this.dashboardService.getVendorDashboardStats(vendorId);
  }

 // Role 5 is Guide
  if (role === SystemRole.GUIDE || guideId > 0) {
    return this.dashboardService.getGuideDashboardStats(guideId);
  }

 // Role 3 is Staff.
 // Staff must receive the same complete dashboard response as Admin.
  if (role === SystemRole.STAFF) {
    return this.dashboardService.getDashboardStats();
  }

 // Role 8 retains the limited Travel Expert dashboard.
  if (role === SystemRole.TRAVEL_EXPERT) {
    return this.dashboardService.getTravelExpertDashboardStats(staffId);
  }

 // Admin and other permitted internal users use the full dashboard.
  if (role === SystemRole.ADMIN) return this.dashboardService.getDashboardStats();
  throw new ForbiddenException('This role does not have dashboard access.');
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
