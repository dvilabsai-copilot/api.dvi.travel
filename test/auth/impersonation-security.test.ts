import assert from 'node:assert/strict';
import test from 'node:test';
import { ImpersonationSafetyGuard } from '../../src/auth/impersonation-safety.guard';
import { SystemRole } from '../../src/modules/auth/constants/system-role.constants';
import { ImpersonationService } from '../../src/modules/auth/impersonation.service';

function request(path: string, user: any, method = 'GET', origin?: string) {
  return {
    route: { path },
    path,
    originalUrl: path,
    method,
    headers: origin ? { origin } : {},
    user,
  };
}

function context(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

test('impersonated requests are blocked from sensitive operations', () => {
  const guard = new ImpersonationSafetyGuard();
  const user = { isImpersonating: true };

  for (const path of ['/auth/change-password', '/users', '/role-permission', '/payments', '/accounts-ledger']) {
    assert.throws(() => guard.canActivate(context(request(path, user))), /sensitive operation/i);
  }

  assert.equal(guard.canActivate(context(request('/itineraries', user))), true);
  assert.equal(guard.canActivate(context(request('/users', { isImpersonating: false }))), true);
});

test('guard normalizes versioned paths, uses segment matching, and protects mutations with origin checks', () => {
  const guard = new ImpersonationSafetyGuard();
  const user = { isImpersonating: true };
  const origin = 'http://localhost:8081';
  const previousOrigins = process.env.CORS_ORIGINS;
  process.env.CORS_ORIGINS = origin;
  try {
    assert.throws(() => guard.canActivate(context(request('/api/v1/role-permissions/12?view=edit', user, 'PATCH', origin))), /sensitive operation/i);
    assert.throws(() => guard.canActivate(context(request('/api/v2/users/12', user, 'DELETE', origin))), /sensitive operation/i);
    assert.throws(() => guard.canActivate(context(request('/api/v1/accounts-ledger-preview', user, 'PATCH'))), /origin/i);
    assert.equal(guard.canActivate(context(request('/api/v1/accounts-ledger-preview', user, 'GET'))), true);
    assert.throws(() => guard.canActivate(context(request('/api/v1/agent/12', user, 'PATCH', origin))), /account administration/i);
    assert.equal(guard.canActivate(context(request('/api/v1/itineraries/12', user, 'PATCH', origin))), true);
    assert.throws(() => guard.canActivate(context(request('/api/v1/itineraries/12', user, 'PATCH', 'https://evil.example'))), /origin/i);
  } finally {
    if (previousOrigins === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previousOrigins;
  }
});

test('only a normal ADMIN may initiate impersonation', async () => {
  const service = new ImpersonationService({} as any, {} as any);
  await assert.rejects(() => service.start({ userId: '10', roleID: 2 }, '20', 'support'), /Only an authenticated ADMIN/i);
  await assert.rejects(() => service.start({ userId: '10', roleID: 1, isImpersonating: true }, '20', 'support'), /Nested impersonation/i);
});

test('impersonation start rejects invalid support reasons before database access', async () => {
  const service = new ImpersonationService({} as any, {} as any);
  await assert.rejects(() => service.start({ userId: '10', roleID: 1 }, '20', 'x'), /support reason/i);
});

test('impersonation session TTL defaults to 15 minutes and clamps to the 5-15 minute range', () => {
  const service = new ImpersonationService({} as any, {} as any);
  const previous = process.env.IMPERSONATION_TTL_MINUTES;
  try {
    delete process.env.IMPERSONATION_TTL_MINUTES;
    assert.equal((service as any).sessionTtlMs(), 15 * 60 * 1000);
    process.env.IMPERSONATION_TTL_MINUTES = '60';
    assert.equal((service as any).sessionTtlMs(), 15 * 60 * 1000);
    process.env.IMPERSONATION_TTL_MINUTES = '1';
    assert.equal((service as any).sessionTtlMs(), 5 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.IMPERSONATION_TTL_MINUTES;
    else process.env.IMPERSONATION_TTL_MINUTES = previous;
  }
});

function makePrisma(users: any[], entityIds: { agent?: number; staff?: number; vendor?: number; guide?: number } = {}) {
  const admin = { userID: 1n, username: 'admin', useremail: 'admin@example.com', roleID: SystemRole.ADMIN, status: 1, userbanned: 0, deleted: 0 };
  const state: any = { createdSession: null };
  const matches = (value: any, condition: any) => {
    if (condition && typeof condition === 'object' && Array.isArray(condition.in)) return condition.in.includes(value);
    if (typeof value === 'bigint' || typeof condition === 'bigint') return String(value) === String(condition);
    return value === condition;
  };
  const activeUsers = () => users.filter((item) => Number(item.status ?? 1) === 1 && Number(item.userbanned ?? 0) === 0 && Number(item.deleted ?? 0) === 0);
  const prisma = {
    dvi_users: {
      findFirst: async ({ where }: any) => {
        if (where?.roleID === SystemRole.ADMIN) return admin;
        if (where?.userID !== undefined) return activeUsers().find((item) => BigInt(item.userID) === BigInt(where.userID)) ?? null;
        return null;
      },
      findMany: async ({ where }: any) => activeUsers().filter((item) =>
        Object.entries(where ?? {}).every(([key, condition]) => {
          if (key === 'roleID' || key === 'agent_id' || key === 'vendor_id' || key === 'staff_id' || key === 'guide_id' || key === 'userID') return matches(item[key], condition);
          return true;
        })),
    },
    dvi_agent: { findFirst: async ({ where }: any) => where.agent_ID === entityIds.agent ? { agent_ID: entityIds.agent, status: 1, deleted: 0 } : null },
    dvi_staff_details: { findFirst: async ({ where }: any) => where.staff_id === entityIds.staff ? { staff_id: entityIds.staff, staff_name: 'Staff', roleID: SystemRole.STAFF, status: 1, deleted: 0 } : null },
    dvi_vendor_details: { findFirst: async ({ where }: any) => where.vendor_id === entityIds.vendor ? { vendor_id: entityIds.vendor, status: 1, deleted: 0 } : null },
    dvi_guide_details: { findFirst: async ({ where }: any) => where.guide_id === entityIds.guide ? { guide_id: entityIds.guide, status: 1, deleted: 0 } : null },
    dvi_hotel_admin_user_hotel: { findFirst: async () => ({ user_id: 77n, status: 1, deleted: 0 }), findMany: async () => [] },
    dvi_role_access: { findMany: async () => [] },
    dvi_pagemenu: { findMany: async () => [] },
    admin_impersonation_sessions: {
      create: async ({ data }: any) => { state.createdSession = data; return data; },
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => state.createdSession,
    },
    admin_impersonation_audit_events: { create: async () => ({}) },
  };
  return { prisma, state };
}

test('role-authoritative mapping keeps a Staff account with agent_id in Staff context', () => {
  const service = new ImpersonationService({} as any, {} as any);
  const relationship = (service as any).entityRelationship({ roleID: SystemRole.STAFF, staff_id: 85, agent_id: 313 });
  assert.deepEqual(relationship, { entityType: 'staff', entityId: 85 });
});

test('role-authoritative mapping resolves Agent and Vendor relationships', () => {
  const service = new ImpersonationService({} as any, {} as any);
  assert.deepEqual((service as any).entityRelationship({ roleID: SystemRole.AGENT, agent_id: 313, vendor_id: 55 }), { entityType: 'agent', entityId: 313 });
  assert.deepEqual((service as any).entityRelationship({ roleID: SystemRole.VENDOR, vendor_id: 55, guide_id: 9 }), { entityType: 'vendor', entityId: 55 });
});

test('resolve returns every active account and does not use the management contact email', async () => {
  const users = [
    { userID: 838n, username: '9509148026', useremail: 'kukkiservices@gmail.com', roleID: SystemRole.AGENT, status: 1, userbanned: 0, deleted: 0, userapproved: 1, agent_id: 313 },
    { userID: 1156n, username: 'Goibibo', useremail: 'aakritverma2010@gmail.com', roleID: SystemRole.AGENT, status: 1, userbanned: 0, deleted: 0, userapproved: 1, agent_id: 313 },
  ];
  const { prisma } = makePrisma(users, { agent: 313 });
  const service = new ImpersonationService(prisma as any, {} as any);
  const result = await service.resolve({ userId: '1', roleID: SystemRole.ADMIN }, 'agent', 313, undefined, 'contact@example.com');
  assert.deepEqual(result.accounts.map((account) => account.userId), ['838', '1156']);
  assert.deepEqual(result.accounts.map((account) => account.email), ['kukkiservices@gmail.com', 'aakritverma2010@gmail.com']);
  assert.equal(result.target, undefined);
});

test('resolve preserves duplicate login emails as separate explicit accounts', async () => {
  const users = [
    { userID: 10n, username: 'One', useremail: 'shared@example.com', roleID: SystemRole.VENDOR, status: 1, userbanned: 0, deleted: 0, vendor_id: 55 },
    { userID: 11n, username: 'Two', useremail: 'shared@example.com', roleID: SystemRole.VENDOR, status: 1, userbanned: 0, deleted: 0, vendor_id: 55 },
  ];
  const { prisma } = makePrisma(users, { vendor: 55 });
  const service = new ImpersonationService(prisma as any, {} as any);
  const result = await service.resolve({ userId: '1', roleID: SystemRole.ADMIN }, 'vendor', 55);
  assert.deepEqual(result.accounts.map((account) => account.userId), ['10', '11']);
  assert.equal(result.accounts[0].email, result.accounts[1].email);
});

test('resolve accepts an explicit account ID and rejects an unrelated account ID', async () => {
  const users = [
    { userID: 10n, username: 'One', useremail: 'one@example.com', roleID: SystemRole.GUIDE, status: 1, userbanned: 0, deleted: 0, guide_id: 7 },
    { userID: 12n, username: 'Other', useremail: 'other@example.com', roleID: SystemRole.GUIDE, status: 1, userbanned: 0, deleted: 0, guide_id: 8 },
  ];
  const { prisma } = makePrisma(users, { guide: 7 });
  const service = new ImpersonationService(prisma as any, {} as any);
  const result = await service.resolve({ userId: '1', roleID: SystemRole.ADMIN }, 'guide', 7, '10');
  assert.equal(result.target?.userId, '10');
  await assert.rejects(() => service.resolve({ userId: '1', roleID: SystemRole.ADMIN }, 'guide', 7, '12'), /not active or is not linked/i);
});

test('start revalidates the selected account using roleID, not foreign-key priority', async () => {
  const users = [
    { userID: 85n, username: 'Aparna', useremail: 'aparna@example.com', roleID: SystemRole.STAFF, status: 1, userbanned: 0, deleted: 0, staff_id: 85, agent_id: 313 },
  ];
  const { prisma, state } = makePrisma(users, { staff: 85 });
  const service = new ImpersonationService(prisma as any, {} as any);
  const result = await service.start({ userId: '1', roleID: SystemRole.ADMIN }, '85', 'support investigation');
  assert.equal(result.target.entityType, 'staff');
  assert.equal(result.target.entityId, '85');
  assert.equal(state.createdSession.entity_type, 'staff');
  assert.equal(String(state.createdSession.entity_id), '85');
});

test('staff impersonation targets carry the same route permission context as normal login', async () => {
  const prisma = {
    dvi_users: {
      findFirst: async ({ where }: any) => where.roleID === 1
        ? { userID: 1n, username: 'admin', useremail: 'admin@example.com' }
        : null,
      findMany: async () => [{
        userID: 1160n,
        username: 'Aparna',
        useremail: 'sales5@dvi.co.in',
        roleID: 3,
        staff_id: 85,
        status: 1,
        userbanned: 0,
        deleted: 0,
      }],
    },
    dvi_staff_details: {
      findFirst: async ({ where }: any) => where.staff_id === 85
        ? { staff_id: 85, staff_name: 'Aparna', roleID: 3, status: 1, deleted: 0 }
        : null,
    },
    dvi_role_access: {
      findMany: async () => [{
        page_menu_id: 1,
        read_access: 1,
        write_access: 0,
        modify_access: 0,
        full_access: 0,
      }],
    },
    dvi_pagemenu: {
      findMany: async () => [{
        page_menu_id: 1,
        page_name: 'dashboard.php',
        page_title: 'Dashboard',
      }],
    },
  };
  const service = new ImpersonationService(prisma as any, {} as any);

  const result = await service.resolve(
    { userId: '1', roleID: 1 },
    'staff',
    85,
    '1160',
  );

  assert.equal(result.target.context.permissionRoleId, 3);
  assert.deepEqual(result.target.context.allowedAccessKeys, ['dashboardphp', 'dashboard']);
  assert.deepEqual(result.target.context.configuredAccessKeys, ['dashboardphp', 'dashboard']);
});

test('audit persistence failures are surfaced as a generic service-unavailable error', async () => {
  const service = new ImpersonationService({ admin_impersonation_audit_events: { create: async () => { throw new Error('database detail'); } } } as any, {} as any);
  await assert.rejects(() => service.recordRequest({ sessionId: 'session', originalAdminUserId: '1', targetUserId: '2', targetRoleId: 2, method: 'GET', path: '/itineraries', statusCode: 200 }), /audit is unavailable/i);
});

test('redeem revalidates the selected account and establishes the isolated impersonation cookie', async () => {
  const target = {
    userID: 20n,
    username: 'Agent 20',
    useremail: 'agent20@example.com',
    roleID: SystemRole.AGENT,
    agent_id: 313,
    status: 1,
    userbanned: 0,
    deleted: 0,
    userapproved: 1,
  };
  const session = {
    session_id: 'session-20',
    original_admin_user_id: 1n,
    target_user_id: 20n,
    target_role_id: SystemRole.AGENT,
    entity_type: 'agent',
    entity_id: 313n,
    status: 'ACTIVE',
    revoked_at: null,
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    handoff_expires_at: new Date(Date.now() + 60 * 1000),
  };
  const response: any = { cookie: (...args: any[]) => { response.cookieArgs = args; } };
  const prisma = {
    admin_impersonation_sessions: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => session,
    },
    dvi_users: {
      findFirst: async () => target,
      findMany: async ({ where }: any) => where.agent_id === 313 ? [target] : [],
    },
    dvi_agent: {
      findFirst: async ({ where }: any) => where.agent_ID === 313 ? { agent_ID: 313, status: 1, deleted: 0 } : null,
    },
    admin_impersonation_audit_events: { create: async () => ({}) },
  };
  const jwt = { signAsync: async () => 'impersonation-jwt' };
  const service = new ImpersonationService(prisma as any, jwt as any);

  const result = await service.redeem('a'.repeat(64), response);

  assert.equal(result.status, 'active');
  assert.equal(result.target.userId, '20');
  assert.equal(response.cookieArgs[0], 'dvi_impersonation_access');
  assert.equal(response.cookieArgs[1], 'impersonation-jwt');
  assert.equal(response.cookieArgs[2].httpOnly, true);
});

test('end closes the impersonation session and clears only the impersonation cookie', async () => {
  let updateWhere: any;
  let clearArgs: any;
  const prisma = {
    admin_impersonation_sessions: {
      findUnique: async () => ({ status: 'ACTIVE' }),
      updateMany: async ({ where }: any) => { updateWhere = where; return { count: 1 }; },
    },
    admin_impersonation_audit_events: { create: async () => ({}) },
  };
  const response: any = { clearCookie: (...args: any[]) => { clearArgs = args; } };
  const service = new ImpersonationService(prisma as any, {} as any);

  const result = await service.end({
    userId: '20',
    roleID: SystemRole.AGENT,
    isImpersonating: true,
    impersonationSessionId: 'session-20',
    originalAdminUserId: '1',
  }, response);

  assert.deepEqual(result, { ended: true });
  assert.deepEqual(updateWhere, { session_id: 'session-20', status: 'ACTIVE' });
  assert.equal(clearArgs[0], 'dvi_impersonation_access');
  assert.equal(clearArgs[1].path, '/api/v1');
});
