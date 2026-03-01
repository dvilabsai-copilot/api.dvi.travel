import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * AdminKeyGuard - Validates x-admin-key header for admin endpoints
 * Compares against ADMIN_EXPORT_KEY environment variable
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const adminKey = request.headers['x-admin-key'];
    const validKey = process.env.ADMIN_EXPORT_KEY;

    if (!adminKey || adminKey !== validKey) {
      throw new UnauthorizedException({
        status: 'failure',
        message: 'Unauthorized',
      });
    }

    return true;
  }
}
