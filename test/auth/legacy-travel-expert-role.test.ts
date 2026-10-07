import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canQuickOnboardAgent,
  isLegacyTravelExpertUser,
} from '../../src/modules/auth/constants/system-role.constants';

test('recognizes legacy PHP Travel Expert role 3', () => {
  const user = { roleID: 3, permissionRoleId: 3, staffId: 123 };

  assert.equal(isLegacyTravelExpertUser(user), true);
  assert.equal(canQuickOnboardAgent(user), true);
});

test('does not grant legacy access to ordinary staff', () => {
  assert.equal(
    canQuickOnboardAgent({ roleID: 3, permissionRoleId: 8, staffId: 123 }),
    false,
  );
});

test('preserves current Travel Expert and Admin access', () => {
  assert.equal(canQuickOnboardAgent({ roleID: 8, staffId: 123 }), true);
  assert.equal(canQuickOnboardAgent({ roleID: 1 }), true);
});
