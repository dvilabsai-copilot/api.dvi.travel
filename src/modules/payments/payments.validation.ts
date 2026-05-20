import * as crypto from 'crypto';

export function verifyRazorpayPaymentSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
  secret: string;
}): boolean {
  const payload = `${input.orderId}|${input.paymentId}`;
  const generated = crypto.createHmac('sha256', input.secret).update(payload).digest('hex');

  const generatedBuffer = Buffer.from(generated, 'utf8');
  const providedBuffer = Buffer.from(input.signature || '', 'utf8');

  if (generatedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(generatedBuffer, providedBuffer);
}

export function validateGatewayAmountAndCurrency(input: {
  expectedAmountPaise: number;
  expectedCurrency: string;
  actualAmountPaise: number;
  actualCurrency: string;
}): void {
  if (input.expectedAmountPaise !== input.actualAmountPaise) {
    throw new Error(
      `Amount mismatch. expected=${input.expectedAmountPaise} actual=${input.actualAmountPaise}`,
    );
  }

  if (input.expectedCurrency !== input.actualCurrency) {
    throw new Error(`Currency mismatch. expected=${input.expectedCurrency} actual=${input.actualCurrency}`);
  }
}

export function isAuthorizedOrCaptured(status?: string): boolean {
  const normalized = (status || '').toLowerCase();
  return normalized === 'captured' || normalized === 'authorized';
}

export function resolveConfirmOutcome(input: { alreadyProcessed: boolean }) {
  if (input.alreadyProcessed) {
    return {
      shouldApply: false,
      status: 'already_processed' as const,
    };
  }

  return {
    shouldApply: true,
    status: 'processed' as const,
  };
}
