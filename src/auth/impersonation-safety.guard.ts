import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// These prefixes represent authorization, credentials, finance, or account
// administration. Matching is segment-aware so /accounts-ledger cannot be
// confused with an unrelated route such as /accounts-ledger-preview.
const ALWAYS_SENSITIVE_PREFIXES = [
  '/auth/change-password',
  '/auth/password-status',
  '/users',
  '/role-permission',
  '/role-permissions',
  '/settings/role-permission',
  '/settings/role-permissions',
  '/hotel-admin-bootstrap',
  '/hotel-admin/users',
  '/payments',
  '/accounts',
  '/accounts-ledger',
  '/accounts-manager',
  '/accounts-export',
  '/auth/legacy-sso',
];

const MUTATING_ACCOUNT_PREFIXES = [
  '/agent',
  '/agents',
  '/staff',
  '/vendor',
  '/vendors',
  '/guide',
  '/drivers',
];

function segmentMatches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function normalizePath(value: unknown): string {
  let pathname = String(value ?? '').split(/[?#]/, 1)[0].trim();
  if (!pathname) return '/';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, '/');
  // Express request paths normally include the global prefix. Removing any
  // versioned prefix also covers requests made through /api/v1 or /api/v2.
  pathname = pathname.replace(/^\/api\/v\d+(?=\/|$)/i, '') || '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function requestPath(request: any): string {
  const candidates = [
    request?.originalUrl,
    `${request?.baseUrl || ''}${request?.path || ''}`,
    request?.path,
    request?.url,
    request?.route?.path,
  ];
  for (const candidate of candidates) {
    const normalized = normalizePath(candidate);
    if (normalized !== '/') return normalized;
  }
  return '/';
}

function configuredOrigins(): string[] {
  return [
    ...String(process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
    String(process.env.IMPERSONATION_FRONTEND_ORIGIN || '').trim(),
  ].filter(Boolean);
}

@Injectable()
export class ImpersonationSafetyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<any>();
    if (!request.user?.isImpersonating) return true;

    const path = requestPath(request);
    const method = String(request.method || 'GET').toUpperCase();
    const isMutating = !READ_METHODS.has(method);

    // The impersonation credential is a cookie. Require the configured target
    // frontend origin on browser mutations so another same-site origin cannot
    // submit a state-changing request with the temporary cookie.
    if (isMutating) {
      const origin = String(request.headers?.origin || '').trim();
      const origins = configuredOrigins();
      if (!origin || !origins.includes(origin)) {
        throw new ForbiddenException('The impersonation request origin is not allowed.');
      }
    }

    if (ALWAYS_SENSITIVE_PREFIXES.some((prefix) => segmentMatches(path, prefix))) {
      throw new ForbiddenException('This sensitive operation is unavailable while impersonating.');
    }

    if (isMutating && MUTATING_ACCOUNT_PREFIXES.some((prefix) => segmentMatches(path, prefix))) {
      throw new ForbiddenException('Account administration is unavailable while impersonating.');
    }

    // Current/end are intentionally allowed so the target can inspect or
    // revoke its own temporary session.
    if (segmentMatches(path, '/auth/impersonation/start') ||
        segmentMatches(path, '/auth/impersonation/resolve') ||
        segmentMatches(path, '/auth/impersonation/history')) {
      throw new ForbiddenException('Nested or administrative impersonation is not allowed.');
    }

    return true;
  }
}

export { normalizePath, requestPath };
