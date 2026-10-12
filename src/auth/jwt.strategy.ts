import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma.service';
import { IMPERSONATION_COOKIE_NAME, IMPERSONATION_TOKEN_TYPE } from '../modules/auth/impersonation.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (request: any) => {
          const raw = String(request?.headers?.cookie || '');
          const pair = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${IMPERSONATION_COOKIE_NAME}=`));
          return pair ? decodeURIComponent(pair.slice(IMPERSONATION_COOKIE_NAME.length + 1)) : null;
        },
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretjwtkey',
    });
  }

  async validate(payload: any) {
    if (payload?.tokenType === IMPERSONATION_TOKEN_TYPE) {
      const sessionId = String(payload.impersonationSessionId || '').trim();
      if (!sessionId) throw new UnauthorizedException('Invalid impersonation session.');
      const session = await this.prisma.admin_impersonation_sessions.findUnique({ where: { session_id: sessionId } });
      if (!session || session.status !== 'ACTIVE' || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now() || String(session.target_user_id) !== String(payload.sub)) {
        throw new UnauthorizedException('Impersonation session is expired or revoked.');
      }
      const [admin, target] = await Promise.all([
        this.prisma.dvi_users.findFirst({ where: { userID: session.original_admin_user_id, roleID: 1, status: 1, userbanned: 0, deleted: 0 } }),
        this.prisma.dvi_users.findFirst({ where: { userID: session.target_user_id, roleID: session.target_role_id, status: 1, userbanned: 0, deleted: 0 } }),
      ]);
      if (!admin || !target) throw new UnauthorizedException('Impersonation identities are no longer eligible.');
      return {
        userId: payload.sub,
        email: payload.email,
        role: payload.role,
        roleID: payload.roleID ?? payload.role,
        agentId: payload.agentId,
        agent_id: payload.agentId,
        vendorId: payload.vendorId,
        vendor_id: payload.vendorId,
        staffId: payload.staffId,
        staff_id: payload.staffId,
        guideId: payload.guideId,
        guide_id: payload.guideId,
        name: payload.name,
        fullName: payload.name,
        permissionRoleId: payload.permissionRoleId,
        allowedAccessKeys: payload.allowedAccessKeys,
        configuredAccessKeys: payload.configuredAccessKeys,
        isImpersonating: true,
        impersonationSessionId: sessionId,
        originalAdminUserId: String(session.original_admin_user_id),
      };
    }
 // attach to req.user
    return {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      roleID: payload.roleID ?? payload.role,
      agentId: payload.agentId,
      agent_id: payload.agentId,
     staffId: payload.staffId,
staff_id: payload.staffId,

permissionRoleId:
  payload.permissionRoleId,

guideId: payload.guideId,
guide_id: payload.guideId,
    };
  }
}
