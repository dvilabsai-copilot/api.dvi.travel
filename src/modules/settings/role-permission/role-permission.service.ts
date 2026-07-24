// FILE: src/modules/role-permission/role-permission.service.ts

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma.service';
import {
  CreateRolePermissionDto,
  RolePermissionPageDto,
  UpdateRolePermissionDto,
  UpdateRolePermissionStatusDto,
} from './dto/role-permission.dto';

const boolToInt = (v: boolean): number => (v ? 1 : 0);
const intToBool = (v: number | null | undefined): boolean => v === 1;

@Injectable()
export class RolePermissionService {
  constructor(private readonly prisma: PrismaService) {}

  private getCreatedByUserId(): number {
 // TODO: replace with real auth integration (req.user.id)
    return 1;
  }

  private normalizeStatus(status: number, deleted: number): boolean {
    return status === 1 && deleted === 0;
  }

 /**
   * Ensure role name is unique (like __ajax_check_rolename.php)
 */
  private async assertUniqueRoleName(roleName: string, ignoreId?: number) {
    const existing = await this.prisma.dvi_rolemenu.findFirst({
      where: {
        role_name: roleName,
        deleted: 0,
        ...(ignoreId
          ? {
              NOT: {
                role_ID: ignoreId,
              },
            }
          : {}),
      },
    });

    if (existing) {
      throw new BadRequestException('Role name already exists');
    }
  }

 /**
   * GET /role-permissions
   * Returns: RolePermissionListItem[]
   * [{ id, roleName, status }]
   * Mirrors __JSONrolemenu.php
 */
  async listRoles() {
    const rows = await this.prisma.dvi_rolemenu.findMany({
      where: {
        deleted: 0,
      },
      orderBy: {
        role_ID: 'desc',
      },
    });

    return rows.map((row) => ({
      id: String(row.role_ID),
      roleName: row.role_name ?? '',
      status: this.normalizeStatus(row.status, row.deleted),
    }));
  }

 /**
   * GET /role-permissions/:id
   * Returns: RolePermissionDetails
   * { id, roleName, status, pages: [...] }
   * Mirrors rolepermission.php edit form + getROLEACCESS_DETAILS().
 */
  async getRoleDetails(id: number) {
    const [role, pages, accessRows] = await this.prisma.$transaction([
      this.prisma.dvi_rolemenu.findFirst({
        where: {
          role_ID: id,
          deleted: 0,
        },
      }),
      this.prisma.dvi_pagemenu.findMany({
        where: {
          deleted: 0,
          status: 1,
        },
        orderBy: {
          page_menu_id: 'asc',
        },
      }),
      this.prisma.dvi_role_access.findMany({
        where: {
          role_ID: id,
          deleted: 0,
        },
      }),
    ]);

    if (!role) {
      throw new NotFoundException(`Role with id ${id} not found`);
    }

    const accessByPageId = new Map<number, (typeof accessRows)[number]>();
    for (const row of accessRows) {
      accessByPageId.set(row.page_menu_id, row);
    }

    const pagesOut = pages.map((page) => {
      const access = accessByPageId.get(page.page_menu_id);
      return {
        pageKey: page.page_name ?? String(page.page_menu_id),
        pageName: page.page_title ?? page.page_name ?? `Page ${page.page_menu_id}`,
        read: access ? intToBool(access.read_access) : false,
        write: access ? intToBool(access.write_access) : false,
        modify: access ? intToBool(access.modify_access) : false,
        full: access ? intToBool(access.full_access) : false,
      };
    });

    return {
      id: String(role.role_ID),
      roleName: role.role_name ?? '',
      status: this.normalizeStatus(role.status, role.deleted),
      pages: pagesOut,
    };
  }

 /**
   * POST /role-permissions
   * Body: RolePermissionPayload
   * Returns: { id: string }
   * Mirrors __ajax_manage_rolemenu.php?type=add (INSERT path).
 */
  async createRole(dto: CreateRolePermissionDto) {
    const roleName = dto.roleName.trim();
    if (!roleName) {
      throw new BadRequestException('Role name is required');
    }

    await this.assertUniqueRoleName(roleName);

    const now = new Date();
    const createdBy = this.getCreatedByUserId();

    const role = await this.prisma.dvi_rolemenu.create({
      data: {
        role_name: roleName,
        createdby: createdBy,
        createdon: now,
        updatedon: now,
        status: 1,
        deleted: 0,
      },
    });

    await this.syncRoleAccess(role.role_ID, roleName, dto.pages, createdBy, now);

    return { id: String(role.role_ID) };
  }

 /**
   * PUT /role-permissions/:id
   * Body: RolePermissionPayload
   * Returns: { ok: true }
   * Mirrors __ajax_manage_rolemenu.php?type=add (UPDATE path).
 */
  async updateRole(id: number, dto: UpdateRolePermissionDto) {
    const role = await this.prisma.dvi_rolemenu.findFirst({
      where: {
        role_ID: id,
        deleted: 0,
      },
    });

    if (!role) {
      throw new NotFoundException(`Role with id ${id} not found`);
    }

    const roleName = dto.roleName.trim();
    if (!roleName) {
      throw new BadRequestException('Role name is required');
    }

    await this.assertUniqueRoleName(roleName, id);

    const now = new Date();
    const createdBy = this.getCreatedByUserId();

    await this.prisma.dvi_rolemenu.update({
      where: { role_ID: id },
      data: {
        role_name: roleName,
        updatedon: now,
      },
    });

    await this.syncRoleAccess(id, roleName, dto.pages, createdBy, now);

    return { ok: true as const };
  }

 /**
   * DELETE /role-permissions/:id
   * Returns: { ok: true }
   * Mirrors type=confirmdelete (soft delete) on dvi_rolemenu + dvi_role_access.
 */
  async deleteRole(id: number) {
    const role = await this.prisma.dvi_rolemenu.findFirst({
      where: {
        role_ID: id,
        deleted: 0,
      },
    });

    if (!role) {
      throw new NotFoundException(`Role with id ${id} not found`);
    }

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.dvi_rolemenu.update({
        where: { role_ID: id },
        data: {
          deleted: 1,
          updatedon: now,
        },
      }),
      this.prisma.dvi_role_access.updateMany({
        where: { role_ID: id, deleted: 0 },
        data: {
          deleted: 1,
          updatedon: now,
        },
      }),
    ]);

    return { ok: true as const };
  }

 /**
   * PATCH /role-permissions/:id/status
   * Body: { status: boolean }
   * Returns: { ok: true }
   * Mirrors type=updatestatus on dvi_rolemenu.
 */
  async updateRoleStatus(id: number, dto: UpdateRolePermissionStatusDto) {
    const role = await this.prisma.dvi_rolemenu.findFirst({
      where: {
        role_ID: id,
        deleted: 0,
      },
    });

    if (!role) {
      throw new NotFoundException(`Role with id ${id} not found`);
    }

    const now = new Date();
    const statusInt = dto.status ? 1 : 0;

    await this.prisma.dvi_rolemenu.update({
      where: { role_ID: id },
      data: {
        status: statusInt,
        updatedon: now,
      },
    });

    return { ok: true as const };
  }

 /**
   * GET /role-permissions/pages
   * Returns list of pages from dvi_pagemenu
   * [{ pageKey, pageName, read, write, modify, full }]
   * This is the dynamic replacement for your FALLBACK_PAGES.
 */
  async listPages() {
    const pages = await this.prisma.dvi_pagemenu.findMany({
      where: {
        deleted: 0,
        status: 1,
      },
      orderBy: {
        page_menu_id: 'asc',
      },
    });

    return pages.map((p) => ({
      pageKey: p.page_name ?? String(p.page_menu_id),
      pageName: p.page_title ?? p.page_name ?? `Page ${p.page_menu_id}`,
      read: false,
      write: false,
      modify: false,
      full: false,
    }));
  }

 /**
   * Internal helper – mirrors PHP behaviour of inserting/updating dvi_role_access
   * based on posted page permissions.
   *
   * For every page from the incoming payload:
   *  - Find matching dvi_pagemenu row where page_name == page.pageKey
   *  - If existing dvi_role_access row -> UPDATE
   *  - Else -> INSERT
   *
   * It does NOT delete missing pages (same as PHP).
 */
private async syncRoleAccess(
    roleId: number,
    roleName: string,
    pages: RolePermissionPageDto[],
    createdBy: number,
    now: Date,
  ) {
    if (!pages || pages.length === 0) return;

 // Load all pages from master
    const pageMenuRows = await this.prisma.dvi_pagemenu.findMany({
      where: {
        deleted: 0,
        status: 1,
      },
    });

    const pageByKey = new Map<string, (typeof pageMenuRows)[number]>();
    for (const p of pageMenuRows) {
      if (p.page_name) {
        pageByKey.set(p.page_name, p);
      }
    }

 // Existing role access rows
    const existingRows = await this.prisma.dvi_role_access.findMany({
      where: {
        role_ID: roleId,
        deleted: 0,
      },
    });

    const existingByPageId = new Map<number, (typeof existingRows)[number]>();
    for (const row of existingRows) {
      existingByPageId.set(row.page_menu_id, row);
    }

 // KEY FIX: type is Prisma.PrismaPromise<any>[]
    const ops: Prisma.PrismaPromise<any>[] = [];

    for (const page of pages) {
      const masterPage = pageByKey.get(page.pageKey);

 // If the pageKey doesn't exist in master, skip silently.
      if (!masterPage) {
        continue;
      }

      const pageMenuId = masterPage.page_menu_id;
      const existing = existingByPageId.get(pageMenuId);

      const read = boolToInt(page.read);
      const write = boolToInt(page.write);
      const modify = boolToInt(page.modify);
      const full = boolToInt(page.full);

      if (existing) {
        ops.push(
          this.prisma.dvi_role_access.update({
            where: { role_access_ID: existing.role_access_ID },
            data: {
              role_ID: roleId,
              role_name: roleName,
              page_menu_id: pageMenuId,
              read_access: read,
              write_access: write,
              modify_access: modify,
              full_access: full,
              createdby: createdBy,
              updatedon: now,
              status: 1,
            },
          }),
        );
      } else {
        ops.push(
          this.prisma.dvi_role_access.create({
            data: {
              role_ID: roleId,
              role_name: roleName,
              page_menu_id: pageMenuId,
              read_access: read,
              write_access: write,
              modify_access: modify,
              full_access: full,
              createdby: createdBy,
              createdon: now,
              updatedon: now,
              status: 1,
              deleted: 0,
            },
          }),
        );
      }
    }

    if (ops.length > 0) {
      await this.prisma.$transaction(ops);
    }
  }
}
