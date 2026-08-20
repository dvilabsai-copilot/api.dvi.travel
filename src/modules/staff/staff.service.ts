// FILE: src/modules/staff/staff.service.ts

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import * as bcrypt from 'bcrypt';

type Tx = Prisma.TransactionClient;

/** --------- Strong output types --------- */
export interface StaffLogin {
  userId: number;
  userEmail: string;
  lastLoggedOn: Date | null;
  status: number;
}

export interface StaffView {
  staffId: number;
  agentId: number;
  staffName: string;
  staffMobile: string;
  staffEmail: string;
  roleId: number;
  status: number;
  deleted: number;
  createdOn: Date | null;
  updatedOn: Date | null;
  login: StaffLogin | null;
 /** Enriched from dvi_rolemenu.role_name */
  roleName?: string;
 /** Enriched from dvi_agent.agent_name + agent_lastname */
  agentName?: string;
}

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

 /** Map DB row API shape (supports optional roleName/agentName passthrough) */
  private mapStaff(row: any): StaffView {
    if (!row) {
      return {
        staffId: 0,
        agentId: 0,
        staffName: '',
        staffMobile: '',
        staffEmail: '',
        roleId: 0,
        status: 0,
        deleted: 0,
        createdOn: null,
        updatedOn: null,
        login: null,
        roleName: undefined,
        agentName: undefined,
      };
    }

    const login: StaffLogin | null = row.login
      ? {
          userId: Number(row.login.userID),
          userEmail: row.login.useremail,
          lastLoggedOn: row.login.last_loggedon ?? null,
          status: Number(row.login.status ?? 0),
        }
      : null;

    return {
      staffId: Number(row.staff_id ?? row.staffId ?? 0),
      agentId: Number(row.agent_id ?? row.agentId ?? 0),
      staffName: row.staff_name ?? row.staffName ?? '',
      staffMobile: row.staff_mobile ?? row.staffMobile ?? '',
      staffEmail: row.staff_email ?? row.staffEmail ?? '',
      roleId: Number(row.roleID ?? row.roleId ?? 0),
      status: Number(row.status ?? 0),
      deleted: Number(row.deleted ?? 0),
      createdOn: row.createdon ?? row.createdOn ?? null,
      updatedOn: row.updatedon ?? row.updatedOn ?? null,
      login,
      roleName: row.roleName ?? row.role_name ?? undefined,
      agentName: row.agentName ?? row.agent_name ?? undefined,
    };
  }

 /** Batch: roleId[] -> Map(roleId -> role_name) */
  private async getRoleMap(roleIds: number[]): Promise<Map<number, string>> {
    const ids = Array.from(
      new Set(roleIds.filter((x) => typeof x === 'number' && !Number.isNaN(x))),
    );
    if (ids.length === 0) return new Map<number, string>();

    const roles = await this.prisma.dvi_rolemenu.findMany({
      where: { role_ID: { in: ids } },
      select: { role_ID: true, role_name: true },
    });

    return new Map<number, string>(roles.map((r) => [Number(r.role_ID), String(r.role_name)]));
  }

 /** Single: roleId -> role_name */
  private async getRoleName(roleId?: number): Promise<string | undefined> {
    if (typeof roleId !== 'number' || Number.isNaN(roleId)) return undefined;
    const role = await this.prisma.dvi_rolemenu.findFirst({
      where: { role_ID: roleId },
      select: { role_name: true },
    });
    return role?.role_name ?? undefined;
  }

 /** Batch: agentIds -> Map(agentId -> "First Last") using dvi_agent */
  private async getAgentMap(agentIds: number[]): Promise<Map<number, string>> {
    const ids = Array.from(new Set(agentIds.filter((x) => typeof x === 'number' && !Number.isNaN(x))));
    if (!ids.length) return new Map<number, string>();

    const agents = await this.prisma.dvi_agent.findMany({
      where: { agent_ID: { in: ids }, deleted: 0 as any },
      select: { agent_ID: true, agent_name: true, agent_lastname: true },
    });

    const m = new Map<number, string>();
    for (const a of agents) {
      const full = [a.agent_name, a.agent_lastname].filter(Boolean).join(' ').trim();
      m.set(Number(a.agent_ID), full || `Agent ${a.agent_ID}`);
    }
    return m;
  }

 /** Single: agentId -> "First Last" */
  private async getAgentFullName(agentId?: number): Promise<string | undefined> {
    if (typeof agentId !== 'number' || Number.isNaN(agentId)) return undefined;
    const a = await this.prisma.dvi_agent.findFirst({
      where: { agent_ID: agentId, deleted: 0 as any },
      select: { agent_name: true, agent_lastname: true },
    });
    if (!a) return undefined;
    const full = [a.agent_name, a.agent_lastname].filter(Boolean).join(' ').trim();
    return full || undefined;
  }

  async getManagedAgentIds(staffId: number): Promise<number[]> {
    const agents = await this.prisma.dvi_agent.findMany({
      where: { travel_expert_id: staffId, deleted: 0 },
      select: { agent_ID: true },
    });
    return agents.map((a) => Number(a.agent_ID));
  }

  async list(params: {
    agentId?: number;
    agentIds?: number[];
    search?: string;
    status?: number;
    page: number;
    pageSize: number;
  }): Promise<{ total: number; page: number; pageSize: number; data: StaffView[] }> {
    const { agentId, agentIds, search, status, page, pageSize } = params;

    const where: Prisma.dvi_staff_detailsWhereInput = {
      deleted: 0,
      ...(typeof agentId === 'number' ? { agent_id: agentId } : {}),
      ...(agentIds && agentIds.length > 0 ? { agent_id: { in: agentIds } } : {}),
      ...(typeof status === 'number' ? { status } : {}),
      ...(search
        ? {
            OR: [
              { staff_name: { contains: search } },
              { staff_email: { contains: search } },
              { staff_mobile: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, rows]: [number, any[]] = await this.prisma.$transaction([
      this.prisma.dvi_staff_details.count({ where }),
      this.prisma.dvi_staff_details.findMany({
        where,
        orderBy: { staff_id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

 // Attach one login record per staff (if present)
    const staffIds = rows.map((r) => Number(r.staff_id));
    const logins = staffIds.length
      ? await this.prisma.dvi_users.findMany({
          where: { deleted: 0, staff_id: { in: staffIds } },
          select: { userID: true, staff_id: true, useremail: true, last_loggedon: true, status: true },
        })
      : [];

    const loginByStaffId = new Map<number, any>();
    logins.forEach((l) => {
      const sid = Number(l.staff_id);
      if (!loginByStaffId.has(sid)) loginByStaffId.set(sid, l);
    });

 // Batch fetch role names & agent names for all rows
    const roleIds = rows.map((r) => Number(r.roleID)).filter((x) => !Number.isNaN(x));
    const roleMap = await this.getRoleMap(roleIds);

    const rowAgentIds = rows.map((r) => Number(r.agent_id)).filter((x) => !Number.isNaN(x));
    const agentMap = await this.getAgentMap(rowAgentIds);

    const data: StaffView[] = rows.map((r) =>
      this.mapStaff({
        ...r,
        login: loginByStaffId.get(Number(r.staff_id)) || null,
        roleName: roleMap.get(Number(r.roleID)),
        agentName: agentMap.get(Number(r.agent_id)),
      }),
    );

    return { total, page, pageSize, data };
  }

  async getOne(staffId: number): Promise<StaffView> {
    const row = await this.prisma.dvi_staff_details.findFirst({
      where: { staff_id: staffId, deleted: 0 },
    });
    if (!row) throw new NotFoundException('Staff not found');

    const [login, roleName, agentName] = await Promise.all([
      this.prisma.dvi_users.findFirst({
        where: { deleted: 0, staff_id: staffId },
        select: { userID: true, useremail: true, last_loggedon: true, status: true },
      }),
      this.getRoleName(Number(row.roleID)),
      this.getAgentFullName(Number(row.agent_id)),
    ]);

    return this.mapStaff({ ...row, login, roleName, agentName });
  }

  async preview(staffId: number): Promise<{
    staff: StaffView;
    loginSummary: { email: string; lastLoggedOn: Date | null } | null;
    stats: Record<string, unknown>;
  }> {
    const staff: StaffView = await this.getOne(staffId);

 // Extend with more stats once branches/vehicles tables are added
    const otherStats = {
 // example: branchCount: await this.prisma.dvi_staff_branches.count({ where: { staff_id: staffId, deleted: 0 } })
    };

    return {
      staff,
      loginSummary: staff.login
        ? { email: staff.login.userEmail, lastLoggedOn: staff.login.lastLoggedOn }
        : null,
      stats: otherStats,
    };
  }

  private async assertUniqueEmailMobile(
    agentId: number,
    staffEmail?: string,
    staffMobile?: string,
    ignoreStaffId?: number,
  ) {
    if (!staffEmail && !staffMobile) return;
    const dup = await this.prisma.dvi_staff_details.findFirst({
      where: {
        deleted: 0,
        agent_id: agentId,
        OR: [
          ...(staffEmail ? [{ staff_email: staffEmail }] as Prisma.dvi_staff_detailsWhereInput[] : []),
          ...(staffMobile ? [{ staff_mobile: staffMobile }] as Prisma.dvi_staff_detailsWhereInput[] : []),
        ],
        ...(ignoreStaffId ? { staff_id: { not: ignoreStaffId } } : {}),
      },
      select: { staff_id: true, staff_email: true, staff_mobile: true },
    });
    if (dup) {
      if (staffEmail && dup.staff_email === staffEmail) throw new BadRequestException('Staff email already exists');
      if (staffMobile && dup.staff_mobile === staffMobile) throw new BadRequestException('Staff mobile already exists');
    }
  }

   async checkDuplicate(
    agentId: number,
    staffEmail?: string,
    staffMobile?: string,
    ignoreStaffId?: number,
  ): Promise<{ emailExists: boolean; mobileExists: boolean }> {
    let emailExists = false;
    let mobileExists = false;

    if (staffEmail) {
      const staffEmailDup = await this.prisma.dvi_staff_details.findFirst({
        where: {
          deleted: 0,
          agent_id: agentId,
          staff_email: staffEmail,
          ...(ignoreStaffId ? { staff_id: { not: ignoreStaffId } } : {}),
        },
        select: { staff_id: true },
      });

      const loginEmailDup = await this.prisma.dvi_users.findFirst({
        where: {
          deleted: 0,
          useremail: staffEmail,
          ...(ignoreStaffId ? { staff_id: { not: ignoreStaffId } } : {}),
        },
        select: { userID: true },
      });

      emailExists = Boolean(staffEmailDup || loginEmailDup);
    }

    if (staffMobile) {
      const staffMobileDup = await this.prisma.dvi_staff_details.findFirst({
        where: {
          deleted: 0,
          agent_id: agentId,
          staff_mobile: staffMobile,
          ...(ignoreStaffId ? { staff_id: { not: ignoreStaffId } } : {}),
        },
        select: { staff_id: true },
      });

      mobileExists = Boolean(staffMobileDup);
    }

    return { emailExists, mobileExists };
  }

  private async assertUniqueLoginEmail(loginEmail: string, ignoreUserId?: bigint) {
    if (!loginEmail) return;
    const dup = await this.prisma.dvi_users.findFirst({
      where: {
        deleted: 0,
        useremail: loginEmail,
        ...(ignoreUserId ? { userID: { not: ignoreUserId } } : {}),
      },
      select: { userID: true },
    });
    if (dup) throw new BadRequestException('Login email already exists');
  }
  async create(input: {
  agentId: number;
  staffName: string;
  staffMobile: string;
  staffEmail: string;
  roleId: number;
  status?: number;
  loginEmail?: string;
  password?: string;
  createdBy?: number;
}): Promise<StaffView> {
  const {
    agentId,
    staffName,
    staffMobile,
    staffEmail,
    roleId,
    status = 1,
    loginEmail,
    password,
    createdBy = 1,
  } = input;

  await this.assertUniqueEmailMobile(agentId, staffEmail, staffMobile);

  if (loginEmail || password) {
    if (!loginEmail) throw new BadRequestException('loginEmail required when creating a login');
    if (!password) throw new BadRequestException('password required when creating a login');
    await this.assertUniqueLoginEmail(loginEmail);
  }

  const now = new Date();

  const { staff, login } = await this.prisma.$transaction(async (tx: Tx) => {
 // Do NOT set updatedon here (omit the field) so it becomes NULL
    const staff = await tx.dvi_staff_details.create({
      data: {
        agent_id: agentId,
        staff_name: staffName,
        staff_mobile: staffMobile,
        staff_email: staffEmail,
        roleID: roleId,
        status,
        deleted: 0,
        createdby: createdBy || 1,
        createdon: now as any,
 // updatedon: null removed to satisfy TS and let DB store NULL
      },
    });

    let login: any = null;
    if (loginEmail && password) {
      const hash = await bcrypt.hash(password, 10);
 // Same: omit updatedon on create so its NULL
      login = await tx.dvi_users.create({
        data: {
          staff_id: staff.staff_id,
          agent_id: agentId,
          useremail: loginEmail,
          password: hash,
          roleID: roleId,
          status,
          deleted: 0,
          createdby: BigInt(createdBy || 1),
          createdon: now as any,
 // updatedon: null removed
        },
      });
    }

    return { staff, login };
  });

  const [roleName, agentName] = await Promise.all([
    this.getRoleName(Number(staff.roleID)),
    this.getAgentFullName(Number(staff.agent_id)),
  ]);
  return this.mapStaff({ ...staff, login, roleName, agentName });
}

  async update(
    staffId: number,
    input: {
      agentId?: number;
      staffName?: string;
      staffMobile?: string;
      staffEmail?: string;
      roleId?: number;
      status?: number;
      loginEmail?: string;
      password?: string;
      updatedBy?: number;
    },
  ): Promise<StaffView> {
    const existing = await this.prisma.dvi_staff_details.findFirst({
      where: { staff_id: staffId, deleted: 0 },
    });
    if (!existing) throw new NotFoundException('Staff not found');

    const agentId = input.agentId ?? existing.agent_id;
    const staffEmail = input.staffEmail ?? existing.staff_email ?? '';
    const staffMobile = input.staffMobile ?? existing.staff_mobile ?? '';

    await this.assertUniqueEmailMobile(agentId, staffEmail, staffMobile, staffId);

    const now = new Date();

    const updated = await this.prisma.dvi_staff_details.update({
      where: { staff_id: staffId },
      data: {
        agent_id: agentId,
        staff_name: input.staffName ?? existing.staff_name,
        staff_mobile: staffMobile,
        staff_email: staffEmail,
        roleID: input.roleId ?? existing.roleID,
        status: typeof input.status === 'number' ? input.status : existing.status,
 updatedon: now as any, // stamp on edit
      },
    });

 // upsert-like behavior for login if loginEmail/password provided
    let login = await this.prisma.dvi_users.findFirst({
      where: { deleted: 0, staff_id: staffId },
      select: { userID: true, useremail: true },
    });

    if (input.loginEmail || input.password) {
      if (!login) {
 // creating a new login on update
        if (!input.loginEmail || !input.password) {
          throw new BadRequestException('Both loginEmail and password are required to create a login');
        }
        await this.assertUniqueLoginEmail(input.loginEmail);
        const hash = await bcrypt.hash(input.password, 10);
        login = await this.prisma.dvi_users.create({
          data: {
            staff_id: staffId,
            agent_id: agentId,
            useremail: input.loginEmail,
            password: hash,
            roleID: updated.roleID,
            status: updated.status,
            deleted: 0,
            createdby: BigInt(input.updatedBy ?? 1),
            createdon: now as any,
 updatedon: now as any, // stamp on creation during update
          },
        });
      } else {
 // update existing login
        if (input.loginEmail) {
          await this.assertUniqueLoginEmail(input.loginEmail, login.userID as unknown as bigint);
        }
        const hash = input.password ? await bcrypt.hash(input.password, 10) : undefined;
        await this.prisma.dvi_users.update({
          where: { userID: login.userID as any },
          data: {
            useremail: input.loginEmail ?? login.useremail ?? undefined,
            ...(hash ? { password: hash } : {}),
 updatedon: now as any, // stamp on edit
          },
        });
      }
    }

    const loginOut = await this.prisma.dvi_users.findFirst({
      where: { deleted: 0, staff_id: staffId },
      select: { userID: true, useremail: true, last_loggedon: true, status: true },
    });

    const [roleName, agentName] = await Promise.all([
      this.getRoleName(Number(updated.roleID)),
      this.getAgentFullName(Number(updated.agent_id)),
    ]);
    return this.mapStaff({ ...updated, login: loginOut || null, roleName, agentName });
  }

  async softDelete(staffId: number): Promise<{ success: true }> {
    const existing = await this.prisma.dvi_staff_details.findFirst({
      where: { staff_id: staffId, deleted: 0 },
    });
    if (!existing) throw new NotFoundException('Staff not found');

    const now = new Date() as any;

    await this.prisma.$transaction([
      this.prisma.dvi_staff_details.update({
        where: { staff_id: staffId },
        data: { deleted: 1, status: 0, updatedon: now },
      }),
      this.prisma.dvi_users.updateMany({
        where: { staff_id: staffId, deleted: 0 },
        data: { deleted: 1, status: 0, updatedon: now },
      }),
    ]);

    return { success: true };
  }

 /** For dynamic Role dropdown */
  async listRoleOptions(): Promise<Array<{ id: number; label: string }>> {
    const rows = await this.prisma.dvi_rolemenu.findMany({
 where: { deleted: 0 }, // relax/remove if you don't have this column
      select: { role_ID: true, role_name: true },
      orderBy: { role_name: 'asc' },
    });
    return rows.map((r) => ({ id: Number(r.role_ID), label: String(r.role_name) }));
  }
}