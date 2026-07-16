import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthService } from '../../src/modules/auth/auth.service';

function createAuth() {
  const purposes: string[] = [];
  const prisma = {
    $queryRaw: async () => [],
  };
  const jwt = {
    signAsync: async (payload: unknown) => {
      assert.deepEqual(payload, {
        purpose: 'registration-email-verification',
        email: 'new@partner.example',
      });
      return 'registration-verification-token';
    },
    verifyAsync: async () => ({
      purpose: 'registration-email-verification',
      email: 'new@partner.example',
    }),
  };
  const emailOtp = {
    createAndSendOtp: async (_email: string, purpose: string) => {
      purposes.push(`send:${purpose}`);
      return { message: 'Verification code sent to your email.' };
    },
    verifyOtp: async (_email: string, _otp: string, purpose: string) => {
      purposes.push(`verify:${purpose}`);
      return true;
    },
  };

  return {
    auth: new AuthService(prisma as never, jwt as never, emailOtp as never),
    purposes,
  };
}

test('registration email OTP is isolated from login OTP and never issues a login response', async () => {
  const { auth, purposes } = createAuth();

  await auth.sendRegistrationEmailOtp('new@partner.example');
  const result = await auth.verifyRegistrationEmailOtp(
    'new@partner.example',
    '123456',
  );

  assert.deepEqual(purposes, ['send:registration', 'verify:registration']);
  assert.deepEqual(result, {
    verified: true,
    verificationToken: 'registration-verification-token',
  });
});
