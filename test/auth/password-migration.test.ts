import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import {
  isBcryptPasswordHash,
  isLegacyPhpPasswordHash,
  verifyLegacyPhpPassword,
} from '../../src/common/utils/password-migration.util';
import { AuthService } from '../../src/modules/auth/auth.service';

function legacyPhpHash(password: string, salt: string): string {
  return salt + createHash('sha1').update(password + salt).digest('hex');
}

test('recognizes and verifies a PHP PwdHash value', () => {
  const password = 'LegacyUser@123';
  const storedHash = legacyPhpHash(password, 'abcdef123');

  assert.equal(isLegacyPhpPasswordHash(storedHash), true);
  assert.equal(verifyLegacyPhpPassword(password, storedHash), true);
  assert.equal(verifyLegacyPhpPassword('wrong-password', storedHash), false);
});

test('recognizes a bcrypt value as current format', async () => {
  const storedHash = await bcrypt.hash('CurrentUser@123', 10);

  assert.equal(isBcryptPasswordHash(storedHash), true);
  assert.equal(isLegacyPhpPasswordHash(storedHash), false);
});

test('logs in with a PHP hash and upgrades it to bcrypt', async () => {
  const password = 'LegacyUser@123';
  const storedHash = legacyPhpHash(password, 'abcdef123');
  let updateArgs: { where?: unknown; data?: unknown } | undefined;
  const prisma = {
    dvi_users: {
      findFirst: async () => ({
        userID: 42n,
        useremail: 'legacy@example.com',
        password: storedHash,
        deleted: 0,
        roleID: 1,
        agent_id: 0,
        staff_id: 0,
        guide_id: 0,
        username: 'Legacy User',
      }),
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  };
  const jwt = { signAsync: async () => 'test-token' };
  const auth = new AuthService(prisma as never, jwt as never);

  const user = await auth.validateUser('legacy@example.com', password);
  assert.equal(user.userID, 42n);
  assert.equal(updateArgs?.where && 'password' in (updateArgs.where as object), true);
  assert.equal(updateArgs?.where && 'userID' in (updateArgs.where as object), true);
  const upgradedHash = (updateArgs?.data as { password: string }).password;
  assert.match(upgradedHash, /^\$2[aby]\$10\$/);
  assert.equal(await bcrypt.compare(password, upgradedHash), true);
});
