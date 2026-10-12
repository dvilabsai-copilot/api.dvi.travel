export const IMPERSONATION_TOKEN_TYPE = 'admin-impersonation' as const;
export const IMPERSONATION_COOKIE_NAME = 'dvi_impersonation_access';
export const IMPERSONATION_SESSION_ACTIVE = 'ACTIVE';
export const IMPERSONATION_SESSION_ENDED = 'ENDED';
export const IMPERSONATION_SESSION_EXPIRED = 'EXPIRED';

export const IMPERSONATION_ENTITY_TYPES = [
  'agent',
  'staff',
  'vendor',
  'guide',
  'hotel-user',
  'user',
] as const;

export type ImpersonationEntityType =
  (typeof IMPERSONATION_ENTITY_TYPES)[number];

export function isImpersonationToken(payload: any): boolean {
  return payload?.tokenType === IMPERSONATION_TOKEN_TYPE;
}
