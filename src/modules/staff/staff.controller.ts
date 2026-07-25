// FILE: src/modules/staff/staff.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { StaffService } from './staff.service';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

@ApiTags('staff')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

 // LIST (kept first)
  @UseGuards(JwtAuthGuard)
  @Get()
  async list(
    @Req() req: any,
    @Query('agentId') agentId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    const user = req.user;
    let finalAgentId = agentId ? Number(agentId) : undefined;
    let agentIds: number[] | undefined = undefined;

 // Role 4 is Agent
    if (user.role === 4) {
      finalAgentId = Number(user.agentId);
    } else if (user.role === 6) {
 // Accounts role - see everything
    } else if (user.role === 3 || user.role === 8 || (user.staffId && user.staffId > 0)) {
 // Travel Expert logic: get agents managed by this staff
      const managedAgents = await this.staffService.getManagedAgentIds(Number(user.staffId));
      if (managedAgents.length > 0) {
        agentIds = managedAgents;
      } else {
        agentIds = [-1];
      }
    }

    return this.staffService.list({
      agentId: finalAgentId,
      agentIds: agentIds,
      search: search || undefined,
      status: status !== undefined ? Number(status) : undefined,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

 // STATIC ROUTE MUST COME BEFORE :id
  @Get('roles')
  async listRoleOptions() {
    return this.staffService.listRoleOptions();
  }

 // GET ONE
  @Get(':id')
  async getOne(@Param('id', new ParseIntPipe()) id: number) {
    return this.staffService.getOne(id);
  }

 // PREVIEW (if you have it; still after :id static roles)
  @Get(':id/preview')
  async preview(@Param('id', new ParseIntPipe()) id: number) {
    return this.staffService.preview(id);
  }

 // CREATE
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const user = req.user;
    let finalAgentId = Number(body.agentId ?? 0);

 // Role 4 is Agent
    if (user.role === 4) {
      finalAgentId = Number(user.agentId);
    }

    return this.staffService.create({
      agentId: finalAgentId,
      staffName: body.staffName,
      staffMobile: body.staffMobile,
      staffEmail: body.staffEmail,
      roleId: Number(body.roleId ?? 0),
      status: Number(body.status ?? 1),
      loginEmail: body.loginEmail,
      password: body.password,
      createdBy: Number(user.userId),
    });
  }

 // UPDATE
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(@Req() req: any, @Param('id', new ParseIntPipe()) id: number, @Body() body: any) {
    const user = req.user;
    let finalAgentId = body.agentId !== undefined ? Number(body.agentId) : undefined;

    if (user.role === 2 || user.role === 6) {
      finalAgentId = Number(user.agentId);
    }

    return this.staffService.update(id, {
      agentId: finalAgentId,
      staffName: body.staffName,
      staffMobile: body.staffMobile,
      staffEmail: body.staffEmail,
      roleId: body.roleId !== undefined ? Number(body.roleId) : undefined,
      status: body.status !== undefined ? Number(body.status) : undefined,
      loginEmail: body.loginEmail,
      password: body.password,
      updatedBy: Number(user.userId),
    });
  }

 // DELETE (soft)
  @Delete(':id')
  async softDelete(@Param('id', new ParseIntPipe()) id: number) {
    return this.staffService.softDelete(id);
  }
}