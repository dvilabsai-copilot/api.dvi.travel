import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OfflineVoucherStayDto } from '../dto/offline-hotel-booking.dto';

type VoucherScope = {
  planId: number;
  groupType: number;
  stay: OfflineVoucherStayDto;
  version: number;
  expiresAt: number;
};

const linkLifetime = 90 * 24 * 60 * 60 * 1000;
const signatureFor = (payload: string, secret: string) =>
  createHmac('sha256', secret).update('offline-hotel-voucher-response:').update(payload).digest();

export function offlineHotelVoucherConfirmationUrl(
  planId: number, groupType: number, stay: OfflineVoucherStayDto, version: number,
) {
  const base = process.env.PUBLIC_ITINERARY_BASE_URL?.trim().replace(/\/+$/, '');
  const secret = process.env.JWT_SECRET?.trim();
  if (!base || !secret) return undefined;
  const scope: VoucherScope = { planId, groupType, stay, version, expiresAt: Date.now() + linkLifetime };
  const payload = Buffer.from(JSON.stringify(scope)).toString('base64url');
  const signature = signatureFor(payload, secret).toString('base64url');
  return `${base}/hotel/voucher-confirmation/${payload}.${signature}`;
}

export function readOfflineHotelVoucherScope(token: string): VoucherScope | undefined {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret || token.length > 8192 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return;
  const [payload, signature] = token.split('.');
  if (!timingSafeEqual(Buffer.from(signature, 'base64url'), signatureFor(payload, secret))) return;
  try {
    const scope = JSON.parse(Buffer.from(payload, 'base64url').toString()) as VoucherScope;
    return scope.expiresAt > Date.now() ? scope : undefined;
  } catch {
    return undefined;
  }
}
