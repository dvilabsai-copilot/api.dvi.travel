import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConfirmOutcome,
  validateGatewayAmountAndCurrency,
  verifyRazorpayPaymentSignature,
} from '../../src/modules/payments/payments.validation';
import * as crypto from 'crypto';

test('signature verification succeeds with valid HMAC', () => {
  const orderId = 'order_123';
  const paymentId = 'pay_123';
  const secret = 'unit_test_secret';
  const payload = `${orderId}|${paymentId}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const valid = verifyRazorpayPaymentSignature({
    orderId,
    paymentId,
    signature,
    secret,
  });

  assert.equal(valid, true);
});

test('amount mismatch raises validation error', () => {
  assert.throws(
    () => {
      validateGatewayAmountAndCurrency({
        expectedAmountPaise: 1000,
        expectedCurrency: 'INR',
        actualAmountPaise: 900,
        actualCurrency: 'INR',
      });
    },
    {
      message: /Amount mismatch/,
    },
  );
});

test('duplicate callback returns already_processed', () => {
  const outcome = resolveConfirmOutcome({ alreadyProcessed: true });
  assert.equal(outcome.shouldApply, false);
  assert.equal(outcome.status, 'already_processed');
});

test('fresh callback returns processed and should apply', () => {
  const outcome = resolveConfirmOutcome({ alreadyProcessed: false });
  assert.equal(outcome.shouldApply, true);
  assert.equal(outcome.status, 'processed');
});
