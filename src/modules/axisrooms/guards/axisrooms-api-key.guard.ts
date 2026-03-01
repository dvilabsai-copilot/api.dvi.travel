import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class AxisRoomsApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(AxisRoomsApiKeyGuard.name);

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request.body;

    const apiKey = process.env.AXISROOMS_API_KEY;
    
    // Debug logging
    this.logger.debug(`Expected API Key from env: ${apiKey ? 'SET' : 'NOT SET'}`);
    this.logger.debug(`Received API Key: ${body?.auth?.key ? 'PROVIDED' : 'MISSING'}`);
    
    if (!apiKey) {
      this.logger.error('AXISROOMS_API_KEY not configured in environment');
      throw new UnauthorizedException({
        message: 'Unauthorized',
        status: 'failure',
      });
    }

    const requestKey = body?.auth?.key;
    
    if (!requestKey || requestKey !== apiKey) {
      this.logger.warn(`Auth failed - Expected: ${apiKey}, Got: ${requestKey}`);
      throw new UnauthorizedException({
        message: 'Unauthorized',
        status: 'failure',
      });
    }

    this.logger.debug('Authentication successful');
    return true;
  }
}
