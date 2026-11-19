export function isTboBookingCancelled(status: unknown): boolean {
  return ['cancelled', 'canceled', 'void', 'voided', 'refunded'].includes(String(status ?? '').trim().toLowerCase());
}
