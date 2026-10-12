import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma.service';
import { SystemRole } from './constants/system-role.constants';
import {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_ENTITY_TYPES,
  IMPERSONATION_SESSION_ACTIVE,
  IMPERSONATION_SESSION_ENDED,
  IMPERSONATION_SESSION_EXPIRED,
  IMPERSONATION_TOKEN_TYPE,
  ImpersonationEntityType,
} from './impersonation.constants';

const HANDOFF_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MIN_SESSION_TTL_MINUTES = 5;
const MAX_SESSION_TTL_MINUTES = 15;

const STAFF_BACKED_ROLES = new Set<number>([
  SystemRole.STAFF,
  SystemRole.ACCOUNTS,
  SystemRole.TRAVEL_EXPERT,
]);

type AuthUser = {
  userId?: string | number;
  role?: string | number;
  roleID?: string | number;
  isImpersonating?: boolean;
  impersonationSessionId?: string;
  originalAdminUserId?: string;
};

type SafeTarget = {
  userId: string;
  entityType: ImpersonationEntityType;
  entityId: string;
  displayName: string;
  email: string;
  roleID: number;
  roleLabel: string;
  status: 'active';
  context: Record<string, unknown>;
};

@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger(ImpersonationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private roleId(user: AuthUser): number {
    return Number(user.roleID ?? user.role ?? 0);
  }

  private parseUserId(value: unknown): bigint {
    try {
      const id = BigInt(String(value ?? '').trim());
      if (id <= 0n) throw new Error('invalid');
      return id;
    } catch {
      throw new BadRequestException('Invalid user account.');
    }
  }

  private assertNormalAdmin(user: AuthUser) {
    if (user?.isImpersonating) {
      throw new ForbiddenException('Nested impersonation is not allowed.');
    }

    if (this.roleId(user) !== SystemRole.ADMIN) {
      throw new ForbiddenException('Only an authenticated ADMIN may impersonate users.');
    }
  }

  private async assertCurrentAdmin(user: AuthUser) {
    this.assertNormalAdmin(user);
    const id = this.parseUserId(user.userId);
    const admin = await this.prisma.dvi_users.findFirst({
      where: { userID: id, roleID: SystemRole.ADMIN, status: 1, userbanned: 0, deleted: 0 },
      select: { userID: true, username: true, useremail: true },
    });
    if (!admin) throw new UnauthorizedException('The ADMIN session is no longer active.');
    return admin;
  }

  private roleLabel(roleID: number): string {
    const labels: Record<number, string> = {
      [SystemRole.ADMIN]: 'ADMIN',
      [SystemRole.VENDOR]: 'Vendor',
      [SystemRole.STAFF]: 'Staff',
      [SystemRole.AGENT]: 'Agent',
      [SystemRole.GUIDE]: 'Guide',
      [SystemRole.ACCOUNTS]: 'Accounts',
      [SystemRole.TRAVEL_EXPERT]: 'Travel Expert',
      [SystemRole.VEHICLE_AGENT]: 'Vehicle Agent',
      [SystemRole.HOTEL_ADMIN]: 'Hotel Admin',
    };
    return labels[roleID] ?? `Role ${roleID}`;
  }

  private displayName(user: any, fallback = 'User'): string {
    return String(user?.username ?? '').trim() || String(user?.useremail ?? '').trim() || fallback;
  }

  private entityRelationship(user: any): { entityType: ImpersonationEntityType; entityId: number } {
    const roleID = Number(user?.roleID ?? 0);
    const relationships: Record<number, { entityType: ImpersonationEntityType; field: string }> = {
      [SystemRole.AGENT]: { entityType: 'agent', field: 'agent_id' },
      [SystemRole.VEHICLE_AGENT]: { entityType: 'agent', field: 'agent_id' },
      [SystemRole.STAFF]: { entityType: 'staff', field: 'staff_id' },
      [SystemRole.ACCOUNTS]: { entityType: 'staff', field: 'staff_id' },
      [SystemRole.TRAVEL_EXPERT]: { entityType: 'staff', field: 'staff_id' },
      [SystemRole.VENDOR]: { entityType: 'vendor', field: 'vendor_id' },
      [SystemRole.GUIDE]: { entityType: 'guide', field: 'guide_id' },
      [SystemRole.HOTEL_ADMIN]: { entityType: 'hotel-user', field: 'userID' },
    };
    const relationship = relationships[roleID];
    if (!relationship) throw new ForbiddenException('The target account has no supported entity relationship.');

    const entityId = Number(user?.[relationship.field] ?? 0);
    if (!Number.isInteger(entityId) || entityId <= 0) {
      throw new ForbiddenException('The target account is not linked to a valid entity.');
    }
    return { entityType: relationship.entityType, entityId };
  }

  private async findEntityUsers(entityType: ImpersonationEntityType, entityId: number, targetUserId?: bigint) {
    if (!IMPERSONATION_ENTITY_TYPES.includes(entityType)) {
      throw new BadRequestException('Unsupported impersonation entity type.');
    }

    const selectMatchingUser = (users: any[]) => targetUserId
      ? users.filter((user) => BigInt(user.userID) === targetUserId)
      : users;

    if (entityType === 'user') {
      const user = await this.prisma.dvi_users.findFirst({ where: { userID: BigInt(entityId), status: 1, userbanned: 0, deleted: 0 } });
      return user && (!targetUserId || BigInt(user.userID) === targetUserId) ? [user] : [];
    }

    if (entityType === 'hotel-user') {
      const assignment = await this.prisma.dvi_hotel_admin_user_hotel.findFirst({
        where: { user_id: BigInt(entityId), status: 1, deleted: 0 },
      });
      if (!assignment) return [];
      const users = await this.prisma.dvi_users.findMany({
        where: { userID: BigInt(entityId), roleID: SystemRole.HOTEL_ADMIN, status: 1, userbanned: 0, deleted: 0 },
      });
      return selectMatchingUser(users);
    }

    if (entityType === 'agent') {
      const entity = await this.prisma.dvi_agent.findFirst({ where: { agent_ID: entityId, status: 1, deleted: 0 } });
      if (!entity) return [];
      const users = await this.prisma.dvi_users.findMany({ where: { agent_id: entityId, roleID: { in: [SystemRole.AGENT, SystemRole.VEHICLE_AGENT] }, status: 1, userbanned: 0, deleted: 0 } });
      return selectMatchingUser(users);
    }

    if (entityType === 'staff') {
      const entity = await this.prisma.dvi_staff_details.findFirst({ where: { staff_id: entityId, status: 1, deleted: 0 } });
      if (!entity) return [];
      const users = await this.prisma.dvi_users.findMany({ where: { staff_id: entityId, roleID: { in: [...STAFF_BACKED_ROLES] }, status: 1, userbanned: 0, deleted: 0 } });
      return selectMatchingUser(users);
    }

    if (entityType === 'vendor') {
      const entity = await this.prisma.dvi_vendor_details.findFirst({ where: { vendor_id: entityId, status: 1, deleted: 0 } });
      if (!entity) return [];
      const users = await this.prisma.dvi_users.findMany({ where: { vendor_id: BigInt(entityId), roleID: SystemRole.VENDOR, status: 1, userbanned: 0, deleted: 0 } });
      return selectMatchingUser(users);
    }

    const entity = await this.prisma.dvi_guide_details.findFirst({ where: { guide_id: entityId, status: 1, deleted: 0 } });
    if (!entity) return [];
    const users = await this.prisma.dvi_users.findMany({ where: { guide_id: entityId, roleID: SystemRole.GUIDE, status: 1, userbanned: 0, deleted: 0 } });
    return selectMatchingUser(users);
  }

  private async targetContext(user: any, entityType: ImpersonationEntityType, entityId: number): Promise<Record<string, unknown>> {
    const context: Record<string, unknown> = {
      agentId: Number(user.agent_id || 0),
      vendorId: Number(user.vendor_id || 0),
      staffId: Number(user.staff_id || 0),
      guideId: Number(user.guide_id || 0),
    };

    // Normal Staff login embeds the role permission context in its JWT. The
    // isolated impersonation window cannot read that HttpOnly cookie, so the
    // same context must be returned with the handoff target for the frontend
    // route guard to evaluate the target's existing permissions.
    if (entityType === 'staff') {
      Object.assign(context, await this.buildStaffContext(user));
    }

    if (entityType === 'hotel-user') {
      const assignments = await this.prisma.dvi_hotel_admin_user_hotel.findMany({
        where: { user_id: user.userID, status: 1, deleted: 0 },
        select: { hotel_id: true },
      });
      context.hotelIds = assignments.map((item) => item.hotel_id);
    }

    if (entityType === 'vendor') context.vendorId = entityId;
    if (entityType === 'agent') context.agentId = entityId;
    if (entityType === 'staff') context.staffId = entityId;
    if (entityType === 'guide') context.guideId = entityId;
    return context;
  }

  private async safeTargetFromUser(user: any, entityType: ImpersonationEntityType, entityId: number): Promise<SafeTarget> {
    const roleID = Number(user.roleID || 0);
    if (roleID === SystemRole.ADMIN) {
      throw new ForbiddenException('ADMIN-to-ADMIN impersonation is not authorized.');
    }
    const expectedRoles: Partial<Record<ImpersonationEntityType, number[]>> = {
      agent: [SystemRole.AGENT, SystemRole.VEHICLE_AGENT],
      staff: [...STAFF_BACKED_ROLES],
      vendor: [SystemRole.VENDOR],
      guide: [SystemRole.GUIDE],
      'hotel-user': [SystemRole.HOTEL_ADMIN],
    };
    const allowedRoles = expectedRoles[entityType];
    if (allowedRoles && !allowedRoles.includes(roleID)) {
      throw new ForbiddenException('The target account is not valid for the selected entity.');
    }
    if (Number(user.status ?? 1) !== 1 || Number(user.userbanned || 0) === 1 || Number(user.deleted || 0) === 1) {
      throw new ForbiddenException('The target account is inactive, banned, or deleted.');
    }
    if ((roleID === SystemRole.AGENT || roleID === SystemRole.VEHICLE_AGENT) && Number(user.userapproved || 0) !== 1) {
      throw new ForbiddenException('The target account is not approved for login.');
    }
    if (roleID <= 0 || roleID === 7) throw new ForbiddenException('The target account has no supported login role.');

    const context = await this.targetContext(user, entityType, entityId);
    const displayName = this.displayName(user);
    return {
      userId: String(user.userID),
      entityType,
      entityId: String(entityId),
      displayName,
      email: String(user.useremail ?? '').trim(),
      roleID,
      roleLabel: this.roleLabel(roleID),
      status: 'active',
      context,
    };
  }

  async resolve(user: AuthUser, entityType: ImpersonationEntityType, entityId: number, targetUserId?: string, _managementContactEmail?: string) {
    await this.assertCurrentAdmin(user);
    const selectedUserId = targetUserId == null || String(targetUserId).trim() === ''
      ? undefined
      : this.parseUserId(targetUserId);
    const users = await this.findEntityUsers(entityType, entityId, selectedUserId);
    if (!users.length) {
      if (selectedUserId) throw new ForbiddenException('The selected login account is not active or is not linked to this entity.');
      throw new NotFoundException('No active login account is linked to that record.');
    }
    const accounts = await Promise.all(users.map((item) => this.safeTargetFromUser(item, entityType, entityId)));
    return {
      eligible: accounts.length > 0,
      accounts,
      ...(accounts.length === 1 ? { target: accounts[0] } : {}),
    };
  }

  async start(user: AuthUser, targetUserId: string, reason: string) {
    const normalizedReason = String(reason ?? '').trim();
    if (normalizedReason.length < 3 || normalizedReason.length > 500) throw new BadRequestException('A support reason between 3 and 500 characters is required.');
    const admin = await this.assertCurrentAdmin(user);
    const targetId = this.parseUserId(targetUserId);
    if (targetId === admin.userID) throw new BadRequestException('Self-impersonation is not allowed.');

    const targetUser = await this.prisma.dvi_users.findFirst({ where: { userID: targetId, deleted: 0 } });
    if (!targetUser) throw new NotFoundException('Target login account was not found.');
    const relationship = this.entityRelationship(targetUser);
    const { entityType, entityId } = relationship;
    const linkedUsers = await this.findEntityUsers(entityType, entityId, targetId);
    if (linkedUsers.length !== 1 || String(linkedUsers[0].userID) !== String(targetUser.userID)) {
      throw new ForbiddenException('The target account mapping is no longer active or valid.');
    }
    const target = await this.safeTargetFromUser(targetUser, entityType, entityId);
    const sessionId = randomUUID();
    const handoffTicket = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs());
    const handoffExpiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);

    await this.prisma.admin_impersonation_sessions.create({
      data: {
        session_id: sessionId,
        original_admin_user_id: admin.userID,
        target_user_id: targetUser.userID,
        target_role_id: target.roleID,
        entity_type: target.entityType,
        entity_id: BigInt(target.entityId),
        reason: normalizedReason,
        created_at: now,
        expires_at: expiresAt,
        status: IMPERSONATION_SESSION_ACTIVE,
        handoff_token_hash: this.hash(handoffTicket),
        handoff_expires_at: handoffExpiresAt,
      },
    });

    try {
      await this.recordRequest({
        sessionId,
        originalAdminUserId: String(admin.userID),
        targetUserId: String(targetUser.userID),
        targetRoleId: target.roleID,
        method: 'POST',
        path: '/auth/impersonation/start',
        statusCode: 201,
      });
    } catch {
      try {
        await this.prisma.admin_impersonation_sessions.updateMany({
          where: { session_id: sessionId, status: IMPERSONATION_SESSION_ACTIVE },
          data: { status: IMPERSONATION_SESSION_ENDED, ended_at: new Date(), revoked_at: new Date() },
        });
      } catch (revokeError) {
        const message = revokeError instanceof Error ? revokeError.message : String(revokeError);
        this.logger.error(`Unable to revoke an impersonation session after audit failure: ${message}`);
      }
      throw new InternalServerErrorException('Impersonation could not be started.');
    }

    return {
      sessionId,
      expiresAt: expiresAt.toISOString(),
      handoffExpiresAt: handoffExpiresAt.toISOString(),
      handoffTicket,
      target,
    };
  }

  private sessionTtlMs() {
    const raw = process.env.IMPERSONATION_TTL_MINUTES;
    const configured = raw == null || raw.trim() === '' ? 15 : Number(raw);
    const safeConfigured = Number.isFinite(configured) ? configured : 15;
    if (safeConfigured > MAX_SESSION_TTL_MINUTES) {
      this.logger.warn(`IMPERSONATION_TTL_MINUTES exceeds ${MAX_SESSION_TTL_MINUTES}; clamping to ${MAX_SESSION_TTL_MINUTES}.`);
    }
    return Math.max(MIN_SESSION_TTL_MINUTES, Math.min(safeConfigured, MAX_SESSION_TTL_MINUTES)) * 60 * 1000 || DEFAULT_SESSION_TTL_MS;
  }

  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private async buildStaffContext(user: any) {
    if (Number(user.staff_id || 0) <= 0) return {};
    const staff = await this.prisma.dvi_staff_details.findFirst({ where: { staff_id: Number(user.staff_id), status: 1, deleted: 0 }, select: { staff_id: true, staff_name: true, roleID: true } });
    if (!staff) throw new ForbiddenException('The target Staff account is not linked to an active staff record.');
    const permissionRoleId = Number(staff.roleID || 0);
    if (!permissionRoleId) return { staffId: Number(staff.staff_id), name: staff.staff_name || user.username || 'Staff', permissionRoleId: 0, allowedAccessKeys: [], configuredAccessKeys: [] };
    const access = await this.prisma.dvi_role_access.findMany({ where: { role_ID: permissionRoleId, status: 1, deleted: 0 }, select: { page_menu_id: true, read_access: true, write_access: true, modify_access: true, full_access: true } });
    const ids = Array.from(new Set(access.map((row) => Number(row.page_menu_id)).filter((id) => id > 0)));
    const pages = ids.length ? await this.prisma.dvi_pagemenu.findMany({ where: { page_menu_id: { in: ids }, status: 1, deleted: 0 }, select: { page_menu_id: true, page_name: true, page_title: true } }) : [];
    const pageMap = new Map(pages.map((page) => [Number(page.page_menu_id), page]));
    const normalize = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    const allowed = new Set<string>();
    const configured = new Set<string>();
    for (const row of access) {
      const page = pageMap.get(Number(row.page_menu_id));
      if (!page) continue;
      const keys = [page.page_name, page.page_title].map(normalize).filter(Boolean);
      keys.forEach((key) => configured.add(key));
      if ([row.read_access, row.write_access, row.modify_access, row.full_access].some((value) => Number(value || 0) === 1)) keys.forEach((key) => allowed.add(key));
    }
    return { staffId: Number(staff.staff_id), name: staff.staff_name || user.username || 'Staff', permissionRoleId, allowedAccessKeys: [...allowed], configuredAccessKeys: [...configured] };
  }

  private async buildImpersonationToken(session: any, targetUser: any) {
    const roleID = Number(targetUser.roleID || 0);
    const staffContext = STAFF_BACKED_ROLES.has(roleID) ? await this.buildStaffContext(targetUser) : {};
    const payload = {
      sub: String(targetUser.userID),
      email: String(targetUser.useremail ?? '').trim(),
      role: roleID,
      roleID,
      agentId: Number(targetUser.agent_id || 0),
      vendorId: Number(targetUser.vendor_id || 0),
      staffId: Number(targetUser.staff_id || 0),
      guideId: Number(targetUser.guide_id || 0),
      name: this.displayName(targetUser),
      tokenType: IMPERSONATION_TOKEN_TYPE,
      impersonationSessionId: session.session_id,
      originalAdminUserId: String(session.original_admin_user_id),
      ...(staffContext || {}),
    };
    const remainingSeconds = Math.max(1, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000));
    return this.jwt.signAsync(payload, { expiresIn: remainingSeconds });
  }

  async redeem(ticket: string, response: any) {
    const normalizedTicket = String(ticket ?? '').trim();
    if (!/^[a-f0-9]{64}$/i.test(normalizedTicket)) throw new UnauthorizedException('Invalid or expired impersonation handoff.');
    const now = new Date();
    const consumed = await this.prisma.admin_impersonation_sessions.updateMany({ where: { handoff_token_hash: this.hash(normalizedTicket), handoff_used_at: null, handoff_expires_at: { gt: now }, status: IMPERSONATION_SESSION_ACTIVE, expires_at: { gt: now } }, data: { handoff_used_at: now } });
    if (consumed.count !== 1) throw new UnauthorizedException('Invalid or expired impersonation handoff.');
    const session = await this.prisma.admin_impersonation_sessions.findUnique({ where: { handoff_token_hash: this.hash(normalizedTicket) } });
    if (!session) throw new UnauthorizedException('Impersonation session was not found.');
    const target = await this.prisma.dvi_users.findFirst({ where: { userID: session.target_user_id, roleID: session.target_role_id, status: 1, userbanned: 0, deleted: 0 } });
    if (!target) throw new ForbiddenException('The target account is no longer eligible.');
    // Keep the exact account selector through the final handoff validation;
    // another active sibling account must not invalidate the selected target.
    const linkedUsers = await this.findEntityUsers(session.entity_type as ImpersonationEntityType, Number(session.entity_id), target.userID);
    if (linkedUsers.length !== 1 || String(linkedUsers[0].userID) !== String(target.userID)) {
      throw new ForbiddenException('The target account is no longer linked to an active entity.');
    }
    const token = await this.buildImpersonationToken(session, target);
    const secure = String(process.env.IMPERSONATION_COOKIE_SECURE ?? 'true').toLowerCase() !== 'false';
    response.cookie(IMPERSONATION_COOKIE_NAME, token, { httpOnly: true, secure, sameSite: 'lax', path: '/api/v1', maxAge: Math.max(1, new Date(session.expires_at).getTime() - Date.now()) });
    return { status: 'active', expiresAt: new Date(session.expires_at).toISOString(), target: await this.safeTargetFromUser(target, session.entity_type as ImpersonationEntityType, Number(session.entity_id)) };
  }

  async current(user: AuthUser) {
    if (!user?.isImpersonating || !user.impersonationSessionId) return { active: false };
    const session = await this.activeSession(user.impersonationSessionId);
    return { active: true, sessionId: session.session_id, expiresAt: new Date(session.expires_at).toISOString(), originalAdmin: { userId: String(session.original_admin_user_id) }, target: { userId: String(session.target_user_id), roleID: session.target_role_id, roleLabel: this.roleLabel(session.target_role_id), displayName: String((await this.prisma.dvi_users.findUnique({ where: { userID: session.target_user_id }, select: { username: true, useremail: true } }))?.username || '') } };
  }

  async end(user: AuthUser, response: any) {
    if (!user?.isImpersonating || !user.impersonationSessionId) throw new ForbiddenException('No active impersonation session.');
    const now = new Date();
    const session = await this.prisma.admin_impersonation_sessions.findUnique({ where: { session_id: user.impersonationSessionId } });
    await this.prisma.admin_impersonation_sessions.updateMany({ where: { session_id: user.impersonationSessionId, status: IMPERSONATION_SESSION_ACTIVE }, data: { status: IMPERSONATION_SESSION_ENDED, ended_at: now, revoked_at: now } });
    this.clearCookie(response);
    await this.recordRequest({
      sessionId: user.impersonationSessionId,
      originalAdminUserId: String(user.originalAdminUserId),
      targetUserId: String(user.userId),
      targetRoleId: this.roleId(user),
      method: 'POST',
      path: '/auth/impersonation/end',
      statusCode: session?.status === IMPERSONATION_SESSION_ACTIVE ? 200 : 409,
    });
    return { ended: true };
  }

  private clearCookie(response: any) {
    response.clearCookie(IMPERSONATION_COOKIE_NAME, { httpOnly: true, secure: String(process.env.IMPERSONATION_COOKIE_SECURE ?? 'true').toLowerCase() !== 'false', sameSite: 'lax', path: '/api/v1' });
  }

  private async activeSession(sessionId: string) {
    const session = await this.prisma.admin_impersonation_sessions.findUnique({ where: { session_id: sessionId } });
    if (!session || session.status !== IMPERSONATION_SESSION_ACTIVE || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) throw new UnauthorizedException('Impersonation session is expired or revoked.');
    const [admin, target] = await Promise.all([
      this.prisma.dvi_users.findFirst({ where: { userID: session.original_admin_user_id, roleID: SystemRole.ADMIN, status: 1, userbanned: 0, deleted: 0 } }),
      this.prisma.dvi_users.findFirst({ where: { userID: session.target_user_id, roleID: session.target_role_id, status: 1, userbanned: 0, deleted: 0 } }),
    ]);
    if (!admin || !target) throw new UnauthorizedException('The impersonation account is no longer eligible.');
    return session;
  }

  async history(user: AuthUser, page = 1, pageSize = 25) {
    const admin = await this.assertCurrentAdmin(user);
    const take = Math.max(1, Math.min(Number(pageSize) || 25, 100));
    const currentPage = Math.max(1, Number(page) || 1);
    const where = { original_admin_user_id: admin.userID };
    const [total, sessions] = await this.prisma.$transaction([
      this.prisma.admin_impersonation_sessions.count({ where }),
      this.prisma.admin_impersonation_sessions.findMany({ where, orderBy: { created_at: 'desc' }, skip: (currentPage - 1) * take, take }),
    ]);
    const ids = sessions.flatMap((item) => [item.original_admin_user_id, item.target_user_id]);
    const users = ids.length ? await this.prisma.dvi_users.findMany({ where: { userID: { in: ids } }, select: { userID: true, username: true, useremail: true } }) : [];
    const byId = new Map(users.map((item) => [String(item.userID), item]));
    return { page: currentPage, pageSize: take, total, items: sessions.map((item) => ({ sessionId: item.session_id, originalAdmin: byId.get(String(item.original_admin_user_id))?.username || byId.get(String(item.original_admin_user_id))?.useremail || String(item.original_admin_user_id), targetUser: byId.get(String(item.target_user_id))?.username || byId.get(String(item.target_user_id))?.useremail || String(item.target_user_id), targetRole: this.roleLabel(item.target_role_id), reason: item.reason, startedAt: item.created_at, endedAt: item.ended_at, status: item.status })) };
  }

  async recordRequest(input: { sessionId: string; originalAdminUserId: string; targetUserId: string; targetRoleId: number; method: string; path: string; statusCode: number }) {
    try {
      await this.prisma.admin_impersonation_audit_events.create({ data: { session_id: input.sessionId, original_admin_user_id: BigInt(input.originalAdminUserId), target_user_id: BigInt(input.targetUserId), target_role_id: input.targetRoleId, method: input.method.slice(0, 16), path: input.path.slice(0, 500), status_code: input.statusCode, created_at: new Date() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Impersonation audit persistence failed for session ${input.sessionId}: ${message}`);
      throw new ServiceUnavailableException('Impersonation audit is unavailable.');
    }
  }

  static cookieName() { return IMPERSONATION_COOKIE_NAME; }
}
