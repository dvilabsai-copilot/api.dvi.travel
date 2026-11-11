import assert from 'node:assert/strict';
import test from 'node:test';
import { withGlobalSettingsCc } from '../src/common/utils/default-email-cc.util';

function settingsReader(ccEmailId: string | null) {
  return {
    dvi_global_settings: {
      findFirst: async () => ({ cc_email_id: ccEmailId }),
    },
  } as any;
}

test('adds Global Settings CC while preserving existing recipients', async () => {
  const message = {
    to: ['agent@example.com'],
    cc: ['expert@example.com'],
    bcc: ['supplier@example.com'],
    subject: 'Test booking',
  };

  const result = await withGlobalSettingsCc(settingsReader('sales@dvi.co.in'), message);

  assert.deepEqual(result.cc, ['expert@example.com', 'sales@dvi.co.in']);
  assert.deepEqual(result.to, message.to);
  assert.deepEqual(result.bcc, message.bcc);
  assert.equal(result.subject, message.subject);
});

test('does not duplicate an address already present in To, CC, or BCC', async () => {
  const message = {
    to: 'Sales Team <sales@dvi.co.in>',
    cc: [{ name: 'Finance', address: 'finance@example.com' }],
  };

  assert.equal(
    await withGlobalSettingsCc(settingsReader(' SALES@DVI.CO.IN ; finance@example.com'), message),
    message,
  );
});

test('does not duplicate a configured address in a comma-separated recipient string', async () => {
  const message = { to: 'agent@example.com, sales@dvi.co.in' };

  assert.equal(await withGlobalSettingsCc(settingsReader('sales@dvi.co.in'), message), message);
});

test('leaves message options unchanged when Global Settings has no valid CC address', async () => {
  const message = { to: 'agent@example.com', subject: 'Test' };

  assert.equal(await withGlobalSettingsCc(settingsReader(null), message), message);
  assert.equal(await withGlobalSettingsCc(settingsReader('not-an-email'), message), message);
});

test('accepts a comma-separated Global Settings list and removes repeated addresses', async () => {
  const result = await withGlobalSettingsCc(
    settingsReader('sales@dvi.co.in, SALES@DVI.CO.IN, finance@example.com'),
    { to: 'agent@example.com' },
  );

  assert.deepEqual(result.cc, ['sales@dvi.co.in', 'finance@example.com']);
});

test('a Global Settings read failure does not block the main email', async () => {
  const message = { to: 'agent@example.com', subject: 'Test' };
  const prisma = { dvi_global_settings: { findFirst: async () => { throw new Error('DB unavailable'); } } } as any;

  assert.equal(await withGlobalSettingsCc(prisma, message), message);
});
