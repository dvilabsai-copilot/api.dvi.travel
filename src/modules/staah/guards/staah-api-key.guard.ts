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
    return this.getClientIpDebugData(request).resolvedClientIp;
  }

  private normalizeIpList(values: unknown): string[] {
    if (Array.isArray(values)) {
      return values
        .flatMap((value) => String(value).split(','))
        .map((value) => this.normalizeIp(value))
        .filter(Boolean);
    }

    if (typeof values === 'string') {
      return values
        .split(',')
        .map((value) => this.normalizeIp(value))
        .filter(Boolean);
    }

    return [];
  }

  private getClientIpDebugData(request: any): {
    resolvedClientIp: string;
    requestIp: string;
    requestIps: string[];
    forwardedFor: string[];
    realIp: string;
    remoteAddress: string;
  } {
    const forwardedFor = this.normalizeIpList(request.headers?.['x-forwarded-for']);
    const realIp = this.normalizeIpList(request.headers?.['x-real-ip'])[0] || '';
    const requestIps = this.normalizeIpList(request.ips);
    const requestIp = this.normalizeIp(request.ip || '');
    const remoteAddress = this.normalizeIp(
      request.connection?.remoteAddress
        || request.socket?.remoteAddress
        || request.connection?.socket?.remoteAddress
        || '',
    );

    const resolvedClientIp = forwardedFor[0]
      || realIp
      || requestIps[0]
      || requestIp
      || remoteAddress;

    return {
      resolvedClientIp,
      requestIp,
      requestIps,
      forwardedFor,
      realIp,
      remoteAddress,
    };
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

    const ipDebug = this.getClientIpDebugData(request);

 this.logger.log(
      `STAAH IP debug resolved=${ipDebug.resolvedClientIp || 'n/a'} request.ip=${ipDebug.requestIp || 'n/a'} request.ips=${ipDebug.requestIps.join('|') || 'n/a'} x-forwarded-for=${ipDebug.forwardedFor.join('|') || 'n/a'} x-real-ip=${ipDebug.realIp || 'n/a'} remoteAddress=${ipDebug.remoteAddress || 'n/a'}`,
    );

    const normalizedIp = ipDebug.resolvedClientIp;

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
