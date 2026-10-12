import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { ImpersonationService } from '../../modules/auth/impersonation.service';

@Injectable()
export class ImpersonationAuditInterceptor implements NestInterceptor {
  constructor(private readonly impersonation: ImpersonationService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<any>();
    const user = request.user;
    if (!user?.isImpersonating || !user.impersonationSessionId) return next.handle();
    const response = context.switchToHttp().getResponse<any>();
    const record = (statusCode: number) => this.impersonation.recordRequest({
      sessionId: user.impersonationSessionId,
      originalAdminUserId: String(user.originalAdminUserId),
      targetUserId: String(user.userId),
      targetRoleId: Number(user.roleID ?? user.role ?? 0),
      method: request.method,
      path: request.originalUrl || `${request.baseUrl || ''}${request.path || ''}` || request.url,
      statusCode,
    });
    return next.handle().pipe(
      mergeMap((value) => from(record(Number(response.statusCode || 200))).pipe(mergeMap(() => [value]))),
      catchError((error) => from(record(Number(error?.status || response.statusCode || 500))).pipe(mergeMap(() => throwError(() => error)))),
    );
  }
}
