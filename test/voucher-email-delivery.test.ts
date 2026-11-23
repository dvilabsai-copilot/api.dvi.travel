import assert from 'node:assert/strict';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { prepareVoucherEmail } from '../src/modules/itineraries/services/voucher-email-delivery';

test('demo delivery exposes intended BCC only in the notice and overrides the SMTP envelope', async (t) => {
  const previous = process.env.VOUCHER_EMAIL_DEMO_RECIPIENT;
  t.after(() => {
    if (previous === undefined) delete process.env.VOUCHER_EMAIL_DEMO_RECIPIENT;
    else process.env.VOUCHER_EMAIL_DEMO_RECIPIENT = previous;
  });
  process.env.VOUCHER_EMAIL_DEMO_RECIPIENT = 'demo@example.com';

  const message = {
    from: 'sending@example.com',
    to: { name: 'Voucher desk', address: 'hotel@example.com' },
    cc: 'ops@example.com',
    bcc: ['audit@example.com'],
    subject: 'Voucher',
    html: '<p>Voucher</p>',
    text: 'Voucher',
  };
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const demo = prepareVoucherEmail({
    ...message,
    envelope: { from: 'sending@example.com', to: ['hotel@example.com', 'ops@example.com', 'audit@example.com'] },
  });
  assert.match(demo.options.html, /<strong>BCC:<\/strong> audit@example.com/);
  assert.match(demo.options.text, /BCC: audit@example.com/);
  const delivered = await transport.sendMail(demo.options);
  assert.deepEqual(delivered.envelope.to, ['demo@example.com']);
  const demoHeaders = delivered.message.toString().split('\r\n\r\n')[0];
  assert.doesNotMatch(demoHeaders, /^(Cc|Bcc):/im);

  process.env.VOUCHER_EMAIL_DEMO_RECIPIENT = '';
  const live = prepareVoucherEmail(message);
  assert.equal(live.options, message);
  assert.equal(live.demo, false);
  const captured = await transport.sendMail(live.options);
  assert.deepEqual(captured.envelope.to, ['hotel@example.com', 'ops@example.com', 'audit@example.com']);
});
