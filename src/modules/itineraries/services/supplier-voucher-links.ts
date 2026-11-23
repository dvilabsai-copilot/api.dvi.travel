import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

const providerHotelSources = new Set(['tbo', 'vsr', 'resavenue', 'hobse', 'axisrooms', 'staah']);

export function isProviderHotelVoucher(provider?: string | null): boolean {
  return providerHotelSources.has(provider?.trim().toLowerCase() ?? '');
}

export type SupplierVoucherScope =
  | { kind: 'offline-hotel'; planId: number; groupType: number; routeId: number; hotelKey: string; checkIn: string; checkOut: string; version: number; hotelName: string }
  | { kind: 'vehicle'; planId: number; voucherId: number; version: number }
  | { kind: 'provider-hotel'; planId: number; hotelId: number; stayIds: number[]; recipientHash: string };

function signingKey(): string {
  const secret = process.env.SUPPLIER_VOUCHER_SIGNING_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new ServiceUnavailableException('Supplier voucher signing is unavailable.');
  }
  return secret;
}

function signature(payload: string, key: string): Buffer {
  return createHmac('sha256', key).update('supplier-voucher:v1:' + payload).digest();
}

function publicOrigin(): string {
  try {
    const url = new URL(
      process.env.PUBLIC_ITINERARY_BASE_URL?.trim() ||
      process.env.FRONTEND_URL?.trim() || '',
    );
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && local && process.env.NODE_ENV !== 'production')) &&
      !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
      return url.origin;
    }
  } catch {
    // Missing or invalid frontend origin.
  }
  throw new ServiceUnavailableException('The supplier voucher website is unavailable.');
}

export function supplierVoucherLink(scope: SupplierVoucherScope): string {
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ scope, expires })).toString('base64url');
  const token = payload + '.' + signature(payload, signingKey()).toString('base64url');
  return publicOrigin() + '/supplier-voucher#token=' + token;
}

export function unavailableVoucher(): NotFoundException {
  return new NotFoundException('This voucher link is invalid, expired, or has been replaced.');
}

export function readSupplierVoucherScope(token: string): SupplierVoucherScope {
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) throw unavailableVoucher();
  const [, payload, supplied] = parts;
  const signed = Buffer.from(supplied, 'base64url');
  const expected = signature(payload, signingKey());
  if (signed.toString('base64url') !== supplied || signed.length !== expected.length ||
      !timingSafeEqual(signed, expected)) {
    throw unavailableVoucher();
  }
  try {
    const { scope, expires } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(expires) && expires > Math.floor(Date.now() / 1000) &&
        ['offline-hotel', 'provider-hotel', 'vehicle'].includes(scope?.kind)) {
      return scope as SupplierVoucherScope;
    }
  } catch {
    // The payload must be a signed voucher scope.
  }
  throw unavailableVoucher();
}

export function voucherEmailAddresses(value?: string | null): string[] {
  return [...new Set((value ?? '').split(/[;,]/).map((email) => email.trim().toLowerCase())
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

export function voucherRecipientHash(email: string): string {
  return createHmac('sha256', signingKey()).update('supplier-recipient:v1:' + email.trim().toLowerCase()).digest('hex');
}

export function linkedVoucherEmail(subject: string, summary: string, url: string, label = 'Confirm Book') {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return {
    subject: subject.replace(/[\r\n]+/g, ' '),
    text: [summary, '', label + ': ' + url].join('\n'),
    html: '<p>' + escape(summary) + '</p><p><a style="display:inline-block;padding:10px 18px;background:#5f129e;color:#fff;text-decoration:none" href="' +
      escape(url) + '">' + escape(label) + '</a></p>',
  };
}
