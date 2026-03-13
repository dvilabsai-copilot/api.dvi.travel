import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { STAAH_MESSAGES } from '../constants/staah-messages';

@Injectable()
export class StaahApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(StaahApiKeyGuard.name);

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    return this.validate(context);
  }

  private validate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const body = request.body || {};

    const apiKey = process.env.STAAH_API_KEY;
    const requestKey = body?.auth?.key || body?.apikey;

    if (!apiKey) {
      this.logger.error('STAAH_API_KEY not configured in environment');
      throw new UnauthorizedException({
        status: 'fail',
        error_desc: STAAH_MESSAGES.UNAUTHORIZED,
      });
    }

    if (!requestKey || requestKey !== apiKey) {
      throw new UnauthorizedException({
        status: 'fail',
        error_desc: STAAH_MESSAGES.UNAUTHORIZED,
      });
    }

    const allowedIpsRaw = process.env.STAAH_ALLOWED_IPS;
    if (!allowedIpsRaw) {
      return true;
    }

    const allowedIps = allowedIpsRaw
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);

    if (allowedIps.length === 0) {
      return true;
    }

    const forwardedFor = request.headers['x-forwarded-for'];
    const forwardedIp = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : typeof forwardedFor === 'string'
        ? forwardedFor.split(',')[0].trim()
        : null;

    const remoteIp =
      forwardedIp ||
      request.ip ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      '';

    const normalizedIp = String(remoteIp).replace('::ffff:', '');

    if (!allowedIps.includes(normalizedIp)) {
      this.logger.warn(`Blocked STAAH request from non-whitelisted IP: ${normalizedIp}`);
      throw new UnauthorizedException({
        status: 'fail',
        error_desc: STAAH_MESSAGES.UNAUTHORIZED,
      });
    }

    return true;
  }
}
