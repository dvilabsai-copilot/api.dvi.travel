// FILE: src/modules/role-permission/role-permission.controller.ts

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolePermissionService } from './role-permission.service';
import {
  CreateRolePermissionDto,
  UpdateRolePermissionDto,
  UpdateRolePermissionStatusDto,
} from './dto/role-permission.dto';

@ApiTags('role-permissions')
@ApiBearerAuth()
@Controller('role-permissions')
export class RolePermissionController {
  constructor(
    private readonly rolePermissionService: RolePermissionService,
  ) {}

 /**
   * GET /role-permissions
   * Frontend: rolePermissionService.list()
   * Returns: RolePermissionListItem[]
 */
  @Get()
  async list() {
    return this.rolePermissionService.listRoles();
  }

 /**
   * GET /role-permissions/pages
   * Frontend: rolePermissionService.listPages()
   * Returns: RolePermissionPageRow[]
 */
  @Get('pages')
  async listPages() {
    return this.rolePermissionService.listPages();
  }

 /**
   * GET /role-permissions/:id
   * Frontend: rolePermissionService.getOne(id)
   * Returns: RolePermissionDetails
 */
  @Get(':id')
  async getOne(@Param('id', ParseIntPipe) id: number) {
    return this.rolePermissionService.getRoleDetails(id);
  }

 /**
   * POST /role-permissions
   * Frontend: rolePermissionService.create(payload)
   * Returns: { id: string }
 */
  @Post()
  async create(@Body() dto: CreateRolePermissionDto) {
    return this.rolePermissionService.createRole(dto);
  }

 /**
   * PUT /role-permissions/:id
   * Frontend: rolePermissionService.update(id, payload)
   * Returns: { ok: true }
 */
  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRolePermissionDto,
  ) {
    return this.rolePermissionService.updateRole(id, dto);
  }

 /**
   * DELETE /role-permissions/:id
   * Frontend: rolePermissionService.remove(id)
   * Returns: { ok: true }
 */
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.rolePermissionService.deleteRole(id);
  }

 /**
   * PATCH /role-permissions/:id/status
   * Frontend: rolePermissionService.updateStatus(id, status)
   * Body: { status: boolean }
   * Returns: { ok: true }
 */
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRolePermissionStatusDto,
  ) {
    return this.rolePermissionService.updateRoleStatus(id, dto);
  }
}
