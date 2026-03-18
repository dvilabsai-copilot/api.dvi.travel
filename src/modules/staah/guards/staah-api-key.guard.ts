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

  private normalizeIp(ip: string): string {
    const trimmed = String(ip || '').trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed === '::1') {
      return '127.0.0.1';
    }

    return trimmed.replace(/^::ffff:/, '');
  }

  private resolveClientIp(request: any): string {
    const trustedChain = Array.isArray(request.ips)
      ? request.ips.map((ip: string) => this.normalizeIp(ip)).filter(Boolean)
      : [];

    if (trustedChain.length > 0) {
      return trustedChain[0];
    }

    const requestIp = this.normalizeIp(request.ip || '');
    if (requestIp) {
      return requestIp;
    }

    const forwardedFor = request.headers?.['x-forwarded-for'];
    const forwardedIp = Array.isArray(forwardedFor)
      ? this.normalizeIp(String(forwardedFor[0]).split(',')[0])
      : typeof forwardedFor === 'string'
        ? this.normalizeIp(forwardedFor.split(',')[0])
        : '';

    if (forwardedIp) {
      return forwardedIp;
    }

    return this.normalizeIp(
      request.connection?.remoteAddress || request.socket?.remoteAddress || '',
    );
  }

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
      .map((ip) => this.normalizeIp(ip))
      .filter((ip) => ip.length > 0);

    if (allowedIps.length === 0) {
      return true;
    }

    const normalizedIp = this.resolveClientIp(request);

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
