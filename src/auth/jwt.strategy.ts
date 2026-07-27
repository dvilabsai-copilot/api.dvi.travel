import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretjwtkey',
    });
  }

  async validate(payload: any) {
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
      guideId: payload.guideId,
      guide_id: payload.guideId,
    };
  }
}
