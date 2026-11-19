import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const APPROVAL_LIFETIME_MS = 5 * 60_000;
const processSecret = randomBytes(32);

const signature = (scope: string, expiresAt: number) =>
  createHmac('sha256', process.env.JWT_SECRET || processSecret)
    .update(JSON.stringify(['tbo-hold-price-approval', scope, expiresAt]))
    .digest();

export function createTboHoldPriceApproval(scope: string, now: Date): string {
  const expiresAt = now.getTime() + APPROVAL_LIFETIME_MS;
  return `${expiresAt}.${signature(scope, expiresAt).toString('hex')}`;
}

export function verifyTboHoldPriceApproval(token: unknown, scope: string, now: Date): boolean {
  if (typeof token !== 'string') return false;
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt <= now.getTime()) return false;
  return timingSafeEqual(Buffer.from(match[2], 'hex'), signature(scope, expiresAt));
}

export function normalizeTboHoldAmount(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}
